import { MasteringSettings, AudioSnapshot, TimelinePoint, EffectRegion } from '../types';
import { FaustCompiler, FaustMonoDspGenerator, LibFaust, instantiateFaustModuleFromFile } from "@grame/faustwasm";
import masteringDsp from '../dsp/mastering.dsp?raw';
import {
  analyzeTone,
  dcOffsetDb,
  measureDcOffset,
  measureLoudnessLra,
  measureMetrics,
  type PipelineMetrics,
} from './audioMeters.ts';

export class AudioEngine {
  private context: AudioContext;
  private source: AudioBufferSourceNode | null = null;
  private buffer: AudioBuffer | null = null;
  private refBuffer: AudioBuffer | null = null;
  // Lite A/B: offline-rendered mastered buffer, played verbatim (no Faust).
  private previewBuffer: AudioBuffer | null = null;
  private previewActive: boolean = false;
  private startTime: number = 0;
  private offset: number = 0;
  private playbackRate: number = 1.0;
  private isPlaying: boolean = false;
  private isRefPlaying: boolean = false;
  private onEnded: () => void = () => {};
  private onErrorCb: ((msg: string) => void) | null = null;

  /** UI hook for engine errors (replaces window.alert). */
  public setOnError(cb: (msg: string) => void) {
    this.onErrorCb = cb;
  }

  private reportError(msg: string) {
    console.error(msg);
    this.onErrorCb?.(msg);
  }

  // Faust
  private faustNode: any = null;
  private compiler: FaustCompiler | null = null;
  private isInitialized: boolean = false;
  
  // Automation
  private activeRegions: EffectRegion[] = [];
  private automationInterval: any = null;
  
  // Nodes
  private inputGain: GainNode;
  private masterSwitch: GainNode;
  private sourceSwitch: GainNode;
  private refSwitch: GainNode;
  private monitorGain: GainNode;
  private outputGain: GainNode;
  
  // Real-time Analysis
  private analyserL: AnalyserNode;
  private analyserR: AnalyserNode;
  private splitter: ChannelSplitterNode;
  
  private bypass: boolean = false;
  private lastSettings: MasteringSettings | null = null;

  public isReady() {
    return this.isInitialized;
  }

  constructor() {
    this.context = new (window.AudioContext || (window as any).webkitAudioContext)();
    
    this.inputGain = this.context.createGain();
    this.masterSwitch = this.context.createGain();
    this.sourceSwitch = this.context.createGain();
    this.refSwitch = this.context.createGain();
    this.monitorGain = this.context.createGain();
    this.outputGain = this.context.createGain();
    
    this.analyserL = this.context.createAnalyser();
    this.analyserR = this.context.createAnalyser();
    this.splitter = this.context.createChannelSplitter(2);
    
    this.analyserL.fftSize = 2048;
    this.analyserR.fftSize = 2048;

    // Ensure stereo across the chain
    [this.inputGain, this.masterSwitch, this.sourceSwitch, this.refSwitch, this.outputGain, this.monitorGain].forEach(node => {
      node.channelCount = 2;
      node.channelCountMode = 'explicit';
    });

    // Initial basic routing (Faust-independent part)
    this.setupBasicRouting();
    
    this.initFaust();
  }

  private setupBasicRouting() {
    // Input to switches
    this.inputGain.connect(this.masterSwitch);
    
    // Dry/Ref to output
    this.sourceSwitch.connect(this.outputGain);
    this.refSwitch.connect(this.outputGain);

    // Final to Analysis & Monitoring
    this.outputGain.connect(this.splitter);
    this.splitter.connect(this.analyserL, 0);
    this.splitter.connect(this.analyserR, 1);

    const merger = this.context.createChannelMerger(2);
    this.splitter.connect(merger, 0, 0);
    this.splitter.connect(merger, 1, 1);
    merger.connect(this.monitorGain);
    this.monitorGain.connect(this.context.destination);

    // Initial Gains
    this.masterSwitch.gain.value = 1;
    this.sourceSwitch.gain.value = 0;
    this.refSwitch.gain.value = 0;
    this.monitorGain.gain.value = 1;
  }

  private async initFaust() {
    console.log("Starting Faust Engine Initialization...");
    try {
      let wasmJs = "https://unpkg.com/@grame/faustwasm@0.16.1/libfaust-wasm/libfaust-wasm.js";
      let wasmData = "https://unpkg.com/@grame/faustwasm@0.16.1/libfaust-wasm/libfaust-wasm.data";
      let wasmWasm = "https://unpkg.com/@grame/faustwasm@0.16.1/libfaust-wasm/libfaust-wasm.wasm";

      if (typeof window !== 'undefined' && (window as any).process?.type === 'renderer') {
        if (window.location.protocol === 'file:') {
          const basePath = window.location.href.substring(0, window.location.href.lastIndexOf('/'));
          wasmJs = `${basePath}/faust/libfaust-wasm.js`;
          wasmData = `${basePath}/faust/libfaust-wasm.data`;
          wasmWasm = `${basePath}/faust/libfaust-wasm.wasm`;
        } else {
          wasmJs = "/faust/libfaust-wasm.js";
          wasmData = "/faust/libfaust-wasm.data";
          wasmWasm = "/faust/libfaust-wasm.wasm";
        }
      }

      const faustModule = await Promise.race([
        instantiateFaustModuleFromFile(wasmJs, wasmData, wasmWasm),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Faust Engine Load Timeout (>10s)")), 10000))
      ]).catch((err: any) => {
        throw new Error(`Failed to load Faust WASM assets: ${err.message || err}`);
      }) as any;

      const libFaust = new LibFaust(faustModule);
      this.compiler = new FaustCompiler(libFaust);
      
      const generator = new FaustMonoDspGenerator();
      await generator.compile(this.compiler, "mastering", masteringDsp, "").catch(err => {
        throw new Error(`Faust Compilation Error: ${err.message}`);
      });
      
      this.faustNode = await generator.createNode(this.context);
      
      if (this.faustNode) {
        // Log available parameters for debugging
        const params = this.faustNode.getParams();
        console.log("Faust Node Created. Available Parameters:", params);

        // Insert Faust into the master chain
        this.masterSwitch.disconnect(); // Clear existing connections from setupBasicRouting
        this.masterSwitch.connect(this.faustNode);
        this.faustNode.connect(this.outputGain);
        
        this.isInitialized = true;
        console.log("Faust Engine INITIALIZED SUCCESSFULLY");
        
        if (this.lastSettings) {
          console.log("Applying buffered settings to Faust...");
          this.updateSettings(this.lastSettings);
        }
      } else {
        throw new Error("Faust node creation returned null");
      }
    } catch (e: any) {
      console.error("Faust Initialization FAILED:", e);
      if (typeof window !== 'undefined') (window as any).faustError = e.message;
      this.reportError("FAUST ERROR:\n" + e.message);
      // Failsafe: connect masterSwitch directly to outputGain so sound still works
      this.masterSwitch.connect(this.outputGain);
      this.isInitialized = true;
    }
  }

  private connectNodes() {
    // This method is now handled by setupBasicRouting and initFaust insertion
  }

  public setRegions(regions: EffectRegion[]) {
    this.activeRegions = regions;
  }

  private startAutomation() {
    if (this.automationInterval) clearInterval(this.automationInterval);
    this.automationInterval = setInterval(() => {
      if (!this.isPlaying || !this.isInitialized || !this.faustNode || !this.lastSettings) return;
      const t = this.getCurrentTime();
      
      const setP = (name: string, val: number) => {
        try {
          if (this.faustNode) {
            const params = this.faustNode.getParams();
            const targetSuffix = `/${name}`;
            const exactPath = `/mastering/${name}`;
            if (params.includes(exactPath)) {
              this.faustNode.setParamValue(exactPath, val);
            } else {
              const matchingParam = params.find((p: string) => p.endsWith(targetSuffix) || p === name);
              if (matchingParam) this.faustNode.setParamValue(matchingParam, val);
            }
          }
        } catch(e) {}
      };

      const activeRegions = this.activeRegions.filter(r => t >= r.start && t <= r.end);
      const stems: ('master' | 'bass' | 'mid' | 'side')[] = ['master', 'bass', 'mid', 'side'];

      stems.forEach(stem => {
        const region = activeRegions.find(r => r.targetStem === stem);
        const prefix = stem === 'master' ? '' : `${stem}_`;
        
        if (region) {
          setP(`${prefix}autotune`, region.effects.autotune || 0);
          setP(`${prefix}reverb`, region.effects.reverb || 0);
          setP(`${prefix}distortion`, region.effects.distortion || 0);
          setP(`${prefix}delay`, region.effects.delay || 0);
          setP(`${prefix}chorus`, region.effects.chorus || 0);
        } else {
          setP(`${prefix}autotune`, (this.lastSettings as any)[`${prefix}autotune`] || 0);
          setP(`${prefix}reverb`, (this.lastSettings as any)[`${prefix}reverb`] || 0);
          setP(`${prefix}distortion`, (this.lastSettings as any)[`${prefix}distortion`] || 0);
          setP(`${prefix}delay`, (this.lastSettings as any)[`${prefix}delay`] || 0);
          setP(`${prefix}chorus`, (this.lastSettings as any)[`${prefix}chorus`] || 0);
        }
      });
    }, 15);
  }

  private stopAutomation() {
    if (this.automationInterval) {
      clearInterval(this.automationInterval);
      this.automationInterval = null;
    }
  }

  public getBypass(): boolean {
    return this.bypass;
  }

  public setBypass(bypass: boolean) {
    this.bypass = bypass;
    const now = this.context.currentTime;
    
    this.masterSwitch.gain.cancelScheduledValues(now);
    this.sourceSwitch.gain.cancelScheduledValues(now);
    this.refSwitch.gain.cancelScheduledValues(now);
    
    this.masterSwitch.gain.setValueAtTime(this.masterSwitch.gain.value, now);
    this.sourceSwitch.gain.setValueAtTime(this.sourceSwitch.gain.value, now);
    this.refSwitch.gain.setValueAtTime(this.refSwitch.gain.value, now);

    if (bypass) {
      this.masterSwitch.gain.setTargetAtTime(0, now, 0.02);
      this.sourceSwitch.gain.setTargetAtTime(1, now, 0.02);
      this.refSwitch.gain.setTargetAtTime(0, now, 0.02);
    } else {
      this.masterSwitch.gain.setTargetAtTime(1, now, 0.02);
      this.sourceSwitch.gain.setTargetAtTime(0, now, 0.02);
      this.refSwitch.gain.setTargetAtTime(0, now, 0.02);
    }
  }

  private makeDistortionCurve(amount: number) {
    const k = amount;
    const n_samples = 44100;
    const curve = new Float32Array(n_samples);
    const deg = Math.PI / 180;
    for (let i = 0; i < n_samples; ++i) {
      const x = (i * 2) / n_samples - 1;
      curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
    }
    return curve;
  }

  public setOnEnded(callback: () => void) {
    this.onEnded = callback;
  }

  public async loadTrack(file: File) {
    const arrayBuffer = await file.arrayBuffer();
    this.buffer = await this.context.decodeAudioData(arrayBuffer);
    this.offset = 0;
    this.isPlaying = false;
    // A new file invalidates any previous offline render.
    this.previewBuffer = null;
    this.previewActive = false;
  }

  public setVolume(value: number) {
    this.monitorGain.gain.setTargetAtTime(value, this.context.currentTime, 0.1);
  }

  public getAudioContext(): AudioContext {
    return this.context;
  }

  public getMonitorGain(): GainNode {
    return this.monitorGain;
  }

  public getDuration(): number {
    return this.buffer ? this.buffer.duration : 0;
  }

  public getCurrentTime(): number {
    const activeBuffer = this.isRefPlaying ? this.refBuffer : this.buffer;
    if (!this.isPlaying || !activeBuffer) return this.offset;
    const elapsed = (this.context.currentTime - this.startTime) * this.playbackRate;
    return Math.min(elapsed + this.offset, activeBuffer.duration);
  }

  public setPlaybackRate(rate: number) {
    const wasPlaying = this.isPlaying;
    if (wasPlaying) {
      this.offset = this.getCurrentTime();
      this.startTime = this.context.currentTime;
    }
    this.playbackRate = rate;
    if (this.source) {
      this.source.playbackRate.setValueAtTime(rate, this.context.currentTime);
    }
  }

  public getPlaybackRate(): number {
    return this.playbackRate;
  }

  public seek(time: number) {
    const wasPlaying = this.isPlaying;
    if (wasPlaying) this.stop();
    this.offset = Math.max(0, Math.min(time, this.getDuration()));
    if (wasPlaying) this.play();
  }

  public async loadReferenceTrack(file: File) {
    const arrayBuffer = await file.arrayBuffer();
    this.refBuffer = await this.context.decodeAudioData(arrayBuffer);
  }

  public toggleReference(enable: boolean) {
    const wasPlaying = this.isPlaying;
    const stateChanged = this.isRefPlaying !== enable;

    if (stateChanged && wasPlaying) this.stop();
    this.isRefPlaying = enable;
    
    const now = this.context.currentTime;
    this.masterSwitch.gain.cancelScheduledValues(now);
    this.sourceSwitch.gain.cancelScheduledValues(now);
    this.refSwitch.gain.cancelScheduledValues(now);
    
    this.masterSwitch.gain.setValueAtTime(this.masterSwitch.gain.value, now);
    this.sourceSwitch.gain.setValueAtTime(this.sourceSwitch.gain.value, now);
    this.refSwitch.gain.setValueAtTime(this.refSwitch.gain.value, now);

    if (enable) {
      this.refSwitch.gain.setTargetAtTime(1, now, 0.02);
      this.masterSwitch.gain.setTargetAtTime(0, now, 0.02);
      this.sourceSwitch.gain.setTargetAtTime(0, now, 0.02);
    } else {
      this.refSwitch.gain.setTargetAtTime(0, now, 0.02);
      if (this.bypass) {
         this.masterSwitch.gain.setTargetAtTime(0, now, 0.02);
         this.sourceSwitch.gain.setTargetAtTime(1, now, 0.02);
      } else {
         this.sourceSwitch.gain.setTargetAtTime(0, now, 0.02);
         this.masterSwitch.gain.setTargetAtTime(1, now, 0.02);
      }
    }

    if (stateChanged && wasPlaying) this.play();
  }

  public play() {
    if (this.context.state === 'suspended') {
      this.context.resume();
    }
    if (this.source) {
      try { this.source.stop(); } catch(e) {}
    }
    
    const usingPreview = !this.isRefPlaying && this.previewActive && this.previewBuffer !== null;
    const activeBuffer = this.isRefPlaying
      ? this.refBuffer
      : usingPreview
        ? this.previewBuffer
        : this.buffer;
    if (!activeBuffer) return;

    this.source = this.context.createBufferSource();
    this.source.buffer = activeBuffer;
    this.source.playbackRate.value = this.playbackRate;

    if (this.isRefPlaying) {
      this.source.connect(this.refSwitch);
    } else if (usingPreview) {
      // Mastered preview plays verbatim (bypasses the Faust chain).
      this.source.connect(this.sourceSwitch);
    } else {
      // Connect to BOTH paths, selection happens via Gain nodes (switches)
      this.source.connect(this.inputGain);
      this.source.connect(this.sourceSwitch);
    }
    
    this.startTime = this.context.currentTime;
    try {
      // Clamp offset to ensure it's valid
      const safeOffset = Math.max(0, Math.min(this.offset, activeBuffer.duration));
      this.source.start(0, safeOffset);
    } catch(e) {
      console.warn("Failed to start source", e);
    }
    this.isPlaying = true;
    this.startAutomation();

    this.source.onended = () => {
      // Small buffer to avoid race conditions with manual stops
      if (this.isPlaying && this.getCurrentTime() >= (activeBuffer.duration - 0.2)) {
        this.isPlaying = false;
        this.offset = 0;
        this.stopAutomation();
        this.onEnded();
      }
    };
  }

  public stop() {
    if (this.source) {
      this.offset = this.getCurrentTime();
      try { this.source.stop(); } catch(e) { /* ignore already stopped */ }
      try { this.source.disconnect(); } catch(e) {}
      this.source = null;
    }
    this.isPlaying = false;
    this.stopAutomation();
  }

  public updateSettings(settings: MasteringSettings) {
    this.lastSettings = settings;
    if (!this.faustNode || !this.isInitialized) return;

    const setParam = (name: string, val: number) => {
      try {
        if (this.faustNode) {
          const params = this.faustNode.getParams();
          const targetSuffix = `/${name}`;
          const exactPath = `/mastering/${name}`;
          
          if (params.includes(exactPath)) {
            this.faustNode.setParamValue(exactPath, val);
          } else {
            // Find any param that ends with the requested name
            const matchingParam = params.find((p: string) => p.endsWith(targetSuffix) || p === name);
            if (matchingParam) {
              this.faustNode.setParamValue(matchingParam, val);
            } else {
             // console.warn(`Faust param not found: ${name}`);
            }
          }
        }
      } catch (e) {
        console.warn(`Failed to set Faust param: ${name}`, e);
      }
    };

    setParam("gain", settings.gain);
    setParam("lowShelf", settings.lowShelf);
    setParam("midRange", settings.midRange);
    setParam("highShelf", settings.highShelf);
    setParam("compression", settings.compression);
    setParam("limiter", settings.limiter);
    setParam("saturation", settings.saturation);
    setParam("exciterAmount", settings.exciterAmount);
    setParam("exciterFreq", settings.exciterFreq);
    setParam("haasAmount", settings.haasAmount);
    setParam("stereoWidth", settings.stereoWidth);
    setParam("fundamentalFreq", settings.fundamentalFreq);
    setParam("eq31", settings.eq31);
    setParam("eq62", settings.eq62);
    setParam("eq125", settings.eq125);
    setParam("eq250", settings.eq250);
    setParam("eq500", settings.eq500);
    setParam("eq1k", settings.eq1k);
    setParam("eq2k", settings.eq2k);
    setParam("eq4k", settings.eq4k);
    setParam("eq8k", settings.eq8k);
    setParam("eq16k", settings.eq16k);
    setParam("autotune", settings.autotune);
    setParam("reverb", settings.reverb);
    setParam("distortion", settings.distortion);
    setParam("delay", settings.delay);
    setParam("chorus", settings.chorus);

    setParam("bass_autotune", settings.bass_autotune);
    setParam("bass_reverb", settings.bass_reverb);
    setParam("bass_distortion", settings.bass_distortion);
    setParam("bass_delay", settings.bass_delay);
    setParam("bass_chorus", settings.bass_chorus);

    setParam("mid_autotune", settings.mid_autotune);
    setParam("mid_reverb", settings.mid_reverb);
    setParam("mid_distortion", settings.mid_distortion);
    setParam("mid_delay", settings.mid_delay);
    setParam("mid_chorus", settings.mid_chorus);

    setParam("side_autotune", settings.side_autotune);
    setParam("side_reverb", settings.side_reverb);
    setParam("side_distortion", settings.side_distortion);
    setParam("side_delay", settings.side_delay);
    setParam("side_chorus", settings.side_chorus);
  }

  public getAnalysers() {
    return { L: this.analyserL, R: this.analyserR };
  }

  /**
   * Offline-render the Pro Faust chain and return the PCM channels.
   * Encoding (WAV/MP3/FLAC, dither, metadata) is the caller's job —
   * see exportEncoders.encodeAudio. `endSec > duration` renders the
   * extra tail (reverb/delay decay) as silence-through-DSP.
   */
  public async renderProPcm(settings: MasteringSettings, startSec: number = 0, endSec: number = 0, regions: EffectRegion[] = []): Promise<{ left: Float32Array; right: Float32Array; sampleRate: number } | null> {
    if (!this.buffer || !this.compiler) return null;

    if (endSec <= 0) endSec = this.buffer.duration;
    if (startSec < 0) startSec = 0;
    if (endSec <= startSec) endSec = startSec + 1;

    const exportDuration = endSec - startSec;
    const length = Math.ceil(exportDuration * this.buffer.sampleRate);
    const renderContext = new OfflineAudioContext(2, length, this.buffer.sampleRate);
    
    // Create Faust Node for Offline Context
    const generator = new FaustMonoDspGenerator();
    await generator.compile(this.compiler, "mastering_export", masteringDsp, "");
    const offlineFaustNode = await generator.createNode(renderContext);

    if (!offlineFaustNode) return null;

    // Apply settings to offline node
    const setParam = (name: string, val: number) => {
      try {
        if (offlineFaustNode) {
          const params = offlineFaustNode.getParams();
          const targetSuffix = `/${name}`;
          const exactPath = `/mastering_export/${name}`;
          if (params.includes(exactPath)) {
            offlineFaustNode.setParamValue(exactPath, val);
          } else {
            const matchingParam = params.find((p: string) => p.endsWith(targetSuffix) || p === name);
            if (matchingParam) offlineFaustNode.setParamValue(matchingParam, val);
          }
        }
      } catch (e) { }
    };

    const applyParams = (t: number) => {
      const activeRegions = regions.filter(r => t >= r.start && t < r.end);
      const stems: ('master' | 'bass' | 'mid' | 'side')[] = ['master', 'bass', 'mid', 'side'];

      stems.forEach(stem => {
        const region = activeRegions.find(r => r.targetStem === stem);
        const prefix = stem === 'master' ? '' : `${stem}_`;
        
        if (region) {
          setParam(`${prefix}autotune`, region.effects.autotune);
          setParam(`${prefix}reverb`, region.effects.reverb);
          setParam(`${prefix}distortion`, region.effects.distortion);
          setParam(`${prefix}delay`, region.effects.delay);
          setParam(`${prefix}chorus`, region.effects.chorus);
        } else {
          setParam(`${prefix}autotune`, (settings as any)[`${prefix}autotune`]);
          setParam(`${prefix}reverb`, (settings as any)[`${prefix}reverb`]);
          setParam(`${prefix}distortion`, (settings as any)[`${prefix}distortion`]);
          setParam(`${prefix}delay`, (settings as any)[`${prefix}delay`]);
          setParam(`${prefix}chorus`, (settings as any)[`${prefix}chorus`]);
        }
      });
    };

    setParam("gain", settings.gain);
    setParam("lowShelf", settings.lowShelf);
    setParam("midRange", settings.midRange);
    setParam("highShelf", settings.highShelf);
    setParam("compression", settings.compression);
    setParam("limiter", settings.limiter);
    setParam("saturation", settings.saturation);
    setParam("exciterAmount", settings.exciterAmount);
    setParam("exciterFreq", settings.exciterFreq);
    setParam("haasAmount", settings.haasAmount);
    setParam("stereoWidth", settings.stereoWidth);
    setParam("fundamentalFreq", settings.fundamentalFreq);
    setParam("eq31", settings.eq31);
    setParam("eq62", settings.eq62);
    setParam("eq125", settings.eq125);
    setParam("eq250", settings.eq250);
    setParam("eq500", settings.eq500);
    setParam("eq1k", settings.eq1k);
    setParam("eq2k", settings.eq2k);
    setParam("eq4k", settings.eq4k);
    setParam("eq8k", settings.eq8k);
    setParam("eq16k", settings.eq16k);
    applyParams(startSec);

    // Schedule suspensions for automation
    if (regions.length > 0) {
      const times = new Set<number>();
      for (const r of regions) {
        if (r.start > startSec && r.start < endSec) times.add(r.start - startSec);
        if (r.end > startSec && r.end < endSec) times.add(r.end - startSec);
      }
      
      const sortedTimes = Array.from(times).sort((a,b) => a - b);
      for (const t of sortedTimes) {
        renderContext.suspend(t).then(() => {
          applyParams(startSec + t);
          renderContext.resume();
        });
      }
    }

    const source = renderContext.createBufferSource();
    source.buffer = this.buffer;

    source.connect(offlineFaustNode);
    offlineFaustNode.connect(renderContext.destination);

    const playDuration = Math.max(0, this.buffer.duration - startSec);
    source.start(0, startSec, playDuration);
    const rendered = await renderContext.startRendering();

    // OfflineAudioContext is created with 2 channels, so both exist
    // (mono sources are upmixed).
    return {
      left: rendered.getChannelData(0),
      right: rendered.numberOfChannels > 1 ? rendered.getChannelData(1) : rendered.getChannelData(0),
      sampleRate: rendered.sampleRate,
    };
  }

  public getContext() {
    return this.context;
  }

  public getBuffer() {
    return this.buffer;
  }

  public getRefBuffer() {
    return this.refBuffer;
  }

  /**
   * Channel data of the loaded track for the offline pipeline (Lite mode).
   * Mono → right is null (the pipeline duplicates to stereo).
   */
  public getChannels(): { left: Float32Array; right: Float32Array | null; sampleRate: number } | null {
    const buf = this.buffer;
    if (!buf) return null;
    return {
      left: buf.getChannelData(0),
      right: buf.numberOfChannels > 1 ? buf.getChannelData(1) : null,
      sampleRate: buf.sampleRate,
    };
  }

  /**
   * Set (or clear) the offline mastered buffer used for A/B preview.
   * `active=false` (or null buf) reverts playback to the original buffer.
   * The preview plays verbatim — it bypasses the Faust chain.
   */
  public setPreviewBuffer(buf: AudioBuffer | null, active: boolean) {
    this.previewBuffer = buf;
    this.previewActive = active && buf !== null;
  }

  public getPreviewActive(): boolean {
    return this.previewActive;
  }

  /**
   * Deep technical analysis of an AudioBuffer using multi-segment Sampling.
   * Async: the fast sampling pass (timeline, stereo, BPM heuristics) runs
   * inline, then the validated audioMeters pipeline supplies the honest
   * BS.1770-4 integrated LUFS + LRA, 6-band tonal map, and DC offset.
   */
  public async analyzeBuffer(buffer: AudioBuffer | null, label: string): Promise<AudioSnapshot | null> {
    if (!buffer) return null;

    const dataL = buffer.getChannelData(0);
    const dataR = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : dataL;
    const sampleRate = buffer.sampleRate;
    const duration = buffer.duration;
    
    // Global Accumulators
    let totalSumSquares = 0;
    let globalPeak = 0;
    let totalCrossProduct = 0;
    let totalSumPowersL = 0;
    let totalSumPowersR = 0;
    let totalSideEnergy = 0;
    let totalCount = 0;

    // Simple BPM detection
    let peaks: number[] = [];
    let bpm = 0;
    let lastPeakTime = 0;

    const timeline: TimelinePoint[] = [];
    const windowSizeInSeconds = 1;
    const windowSize = sampleRate * windowSizeInSeconds;

    // Temporal Analysis with 1s step
    for (let t = 0; t < duration; t += windowSizeInSeconds) {
      const start = Math.floor(t * sampleRate);
      const end = Math.min(start + windowSize, dataL.length);
      
      let localSumSq = 0;
      let localPeak = 0;
      let localSideEnergy = 0;
      let localCount = 0;

      // Internal sampling step for performance (400 samples per window is plenty for RMS)
      const internalStep = Math.max(1, Math.floor((end - start) / 400));
      const currentTimeInAudio = (idx: number) => idx / sampleRate;

      for (let i = start; i < end; i += internalStep) {
        const valL = dataL[i];
        const valR = dataR[i];

        // Basic peak detection for BPM inside the sampled range
        const energy = Math.abs(valL) + Math.abs(valR);
        if (energy > 0.8 && (currentTimeInAudio(i) - lastPeakTime) > 0.25) { // At least 250ms diff (240BPM limit)
           peaks.push(currentTimeInAudio(i));
           lastPeakTime = currentTimeInAudio(i);
        }
        const absL = Math.abs(valL);
        const absR = Math.abs(valR);

        if (absL > localPeak) localPeak = absL;
        if (absR > localPeak) localPeak = absR;
        if (absL > globalPeak) globalPeak = absL;
        if (absR > globalPeak) globalPeak = absR;

        const monoSumSq = (valL * valL + valR * valR) / 2;
        localSumSq += monoSumSq;
        localSideEnergy += (valL - valR) * (valL - valR);
        
        totalSumSquares += monoSumSq;
        totalCrossProduct += valL * valR;
        totalSumPowersL += valL * valL;
        totalSumPowersR += valR * valR;
        totalSideEnergy += (valL - valR) * (valL - valR);
        
        localCount++;
        totalCount++;
      }

      if (localCount > 0) {
        const localRms = Math.sqrt(localSumSq / localCount);
        const localRmsDb = 20 * Math.log10(localRms || 1e-6);
        const localPeakDb = 20 * Math.log10(localPeak || 1e-6);
        const localSideRms = Math.sqrt(localSideEnergy / localCount);
        const localWidth = Math.min(1, localSideRms / (localRms + 1e-6));

        timeline.push({
          t,
          rms: Math.max(-60, localRmsDb),
          peak: Math.max(-60, localPeakDb),
          w: localWidth
        });
      }
    }

    const rms = Math.sqrt(totalSumSquares / totalCount);
    const rmsDb = 20 * Math.log10(rms || 1e-6);
    const peakDb = 20 * Math.log10(globalPeak || 1e-6);
    
    // Estimate BPM from intervals
    let estimatedBpm = 0;
    if (peaks.length > 2) {
      let intervals = [];
      for (let i = 1; i < peaks.length; i++) intervals.push(peaks[i] - peaks[i-1]);
      // find median interval
      intervals.sort((a,b) => a - b);
      const medianInterval = intervals[Math.floor(intervals.length / 2)];
      if (medianInterval > 0) estimatedBpm = Math.round(60 / medianInterval);
      if (estimatedBpm < 60) estimatedBpm *= 2; // Usually people don't want 45 bpm, more like 90
      if (estimatedBpm > 200) estimatedBpm /= 2;
    }

    const correlation = totalCount > 0 ? totalCrossProduct / (Math.sqrt(totalSumPowersL * totalSumPowersR) || 1) : 0;
    const sideRms = Math.sqrt(totalSideEnergy / totalCount);
    const stereoWidth = Math.min(1, sideRms / (rms + 1e-6));

    // Honest measurements (same validated engine as the mastering pipeline).
    const { integratedLufs, lra } = await measureLoudnessLra(dataL, dataR, sampleRate);
    const tone = analyzeTone(dataL, dataR, sampleRate);
    const dc = measureDcOffset(dataL, dataR);

    return {
      timestamp: Date.now(),
      label,
      bpm: estimatedBpm,
      levels: {
        peak: peakDb,
        rms: rmsDb,
        lufs: integratedLufs,
        crestFactor: Math.min(20, peakDb - rmsDb)
      },
      lra,
      dcOffsetDb: dcOffsetDb(dc),
      spectrum: {
        sub: tone.panel.sub,
        low: tone.panel.low,
        lowMid: tone.panel.lowMid,
        mid: tone.panel.mid,
        highMid: tone.panel.highMid,
        high: tone.panel.high
      },
      stereo: {
        correlation: Math.max(-1, Math.min(1, correlation)),
        width: stereoWidth
      },
      timeline
    };
  }

  /**
   * Full pre-mastering metrics for the loaded track (integrated LUFS, LRA,
   * 4x true peak, crest, phase, DC, tonal profile). Runs async — fire it
   * after load and let it finish in the background.
   */
  public async measureTrack(buffer: AudioBuffer | null): Promise<PipelineMetrics | null> {
    if (!buffer || !this.isReady()) return null;
    return measureMetrics(
      buffer.getChannelData(0),
      buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null,
      buffer.sampleRate
    );
  }

  /**
   * Renders the processed signal to capture the "Final" technical state.
   */
  public async analyzeProcessed(label: string, settings: MasteringSettings): Promise<AudioSnapshot | null> {
    if (!this.buffer || !this.compiler) return null;

    // Use a representative segment (loudest part of first 30s)
    const scanDuration = Math.min(30, this.buffer.duration);
    const data = this.buffer.getChannelData(0);
    let loudestStart = 0;
    let maxEnergy = -1;
    
    // Scan in 1s windows to find energy peak
    for (let t = 0; t < scanDuration - 5; t += 2) {
      let energy = 0;
      const start = Math.floor(t * this.buffer.sampleRate);
      const end = start + Math.floor(5 * this.buffer.sampleRate);
      for (let i = start; i < end; i += 1000) {
        energy += data[i] * data[i];
      }
      if (energy > maxEnergy) {
        maxEnergy = energy;
        loudestStart = t;
      }
    }

    const renderLength = 5;
    const offlineCtx = new OfflineAudioContext(2, 44100 * renderLength, 44100);

    // Create Faust Node for Analysis
    const generator = new FaustMonoDspGenerator();
    await generator.compile(this.compiler, "mastering_analysis", masteringDsp, "");
    const analysisNode = await generator.createNode(offlineCtx);

    if (!analysisNode) return null;

    // Apply settings to analysis node
    const setParam = (name: string, val: number) => {
      try {
        if (analysisNode) {
          const params = analysisNode.getParams();
          const targetSuffix = `/${name}`;
          const exactPath = `/mastering_analysis/${name}`;
          if (params.includes(exactPath)) {
            analysisNode.setParamValue(exactPath, val);
          } else {
            const matchingParam = params.find((p: string) => p.endsWith(targetSuffix) || p === name);
            if (matchingParam) analysisNode.setParamValue(matchingParam, val);
          }
        }
      } catch (e) { }
    };

    setParam("gain", settings.gain);
    setParam("lowShelf", settings.lowShelf);
    setParam("midRange", settings.midRange);
    setParam("highShelf", settings.highShelf);
    setParam("compression", settings.compression);
    setParam("limiter", settings.limiter);
    setParam("saturation", settings.saturation);
    setParam("exciterAmount", settings.exciterAmount);
    setParam("exciterFreq", settings.exciterFreq);
    setParam("haasAmount", settings.haasAmount);
    setParam("stereoWidth", settings.stereoWidth);
    setParam("fundamentalFreq", settings.fundamentalFreq);
    setParam("eq31", settings.eq31);
    setParam("eq62", settings.eq62);
    setParam("eq125", settings.eq125);
    setParam("eq250", settings.eq250);
    setParam("eq500", settings.eq500);
    setParam("eq1k", settings.eq1k);
    setParam("eq2k", settings.eq2k);
    setParam("eq4k", settings.eq4k);
    setParam("eq8k", settings.eq8k);
    setParam("eq16k", settings.eq16k);
    setParam("autotune", settings.autotune);
    setParam("reverb", settings.reverb);
    setParam("distortion", settings.distortion);
    setParam("delay", settings.delay);
    setParam("chorus", settings.chorus);

    setParam("bass_autotune", settings.bass_autotune);
    setParam("bass_reverb", settings.bass_reverb);
    setParam("bass_distortion", settings.bass_distortion);
    setParam("bass_delay", settings.bass_delay);
    setParam("bass_chorus", settings.bass_chorus);

    setParam("mid_autotune", settings.mid_autotune);
    setParam("mid_reverb", settings.mid_reverb);
    setParam("mid_distortion", settings.mid_distortion);
    setParam("mid_delay", settings.mid_delay);
    setParam("mid_chorus", settings.mid_chorus);

    setParam("side_autotune", settings.side_autotune);
    setParam("side_reverb", settings.side_reverb);
    setParam("side_distortion", settings.side_distortion);
    setParam("side_delay", settings.side_delay);
    setParam("side_chorus", settings.side_chorus);

    const source = offlineCtx.createBufferSource();
    source.buffer = this.buffer;

    source.connect(analysisNode);
    analysisNode.connect(offlineCtx.destination);

    source.start(0, loudestStart);
    const renderedBuffer = await offlineCtx.startRendering();

    const snap = await this.analyzeBuffer(renderedBuffer, label);
    if (!snap) return null;
    return {
      ...snap,
      settings: { ...settings }
    };
  }
}
