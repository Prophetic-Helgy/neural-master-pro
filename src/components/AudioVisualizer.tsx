import React, { useRef, useEffect, useState } from 'react';

interface Props {
  analyser: AnalyserNode | null;
  mode: 'bars' | 'circle' | 'wave' | 'alchemy' | 'circles' | 'flight' | 'smoke';
  coverArt?: string | null;
  width?: number;
  height?: number;
  onCanvasReady?: (canvas: HTMLCanvasElement) => void;
  exportMode?: boolean;
  metadata?: { title: string };
  coverOffset?: { x: number; y: number };
  /** Background stock clips (export mode), rotation order; up to 4. */
  bgVideoUrls?: string[] | null;
  /** Cut-point times in seconds from the export start (audio peaks). */
  bgCueTimes?: number[] | null;
  /** Audio clock: seconds since export start (the cue math reads it per frame). */
  bgGetTime?: () => number;
  creditText?: string | null;
  /** Reports the created (detached) video elements in selection order. */
  onBgVideosReady?: (videos: HTMLVideoElement[]) => void;
}

export const AudioVisualizer: React.FC<Props> = ({ analyser, mode, coverArt, width = 800, height = 200, exportMode, metadata, onCanvasReady, coverOffset = { x: 0, y: 0 }, bgVideoUrls, bgCueTimes, bgGetTime, creditText, onBgVideosReady }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const videoElsRef = useRef<HTMLVideoElement[]>([]);
  const [dimensions, setDimensions] = useState({ w: width, h: height });

  // Latest bg props for the rAF loop — assigned after every render, read per
  // frame (NOT a draw dep: swapping the array must not restart the loop).
  const bgStateRef = useRef<{ urls: string[]; cues: number[]; getTime: (() => number) | null }>({ urls: [], cues: [], getTime: null });
  useEffect(() => {
    bgStateRef.current = { urls: bgVideoUrls ?? [], cues: bgCueTimes ?? [], getTime: bgGetTime ?? null };
  });

  useEffect(() => {
    if (exportMode) {
      setDimensions({ w: width, h: height });
      return;
    }
    
    if (!containerRef.current) return;
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        setDimensions({
          w: Math.floor(entry.contentRect.width),
          h: Math.floor(entry.contentRect.height)
        });
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [exportMode, width, height]);

  useEffect(() => {
    if (canvasRef.current && onCanvasReady) {
      onCanvasReady(canvasRef.current);
    }
  }, [onCanvasReady, dimensions]);

  useEffect(() => {
    if (coverArt) {
      const img = new Image();
      img.src = coverArt;
      img.onload = () => { imageRef.current = img; };
    } else {
      imageRef.current = null;
    }
  }, [coverArt]);

  // Background stock clips (export mode only). The elements live in a ref —
  // the rAF loop reads them every frame, so they are deliberately NOT draw
  // deps. Each clip plays continuously from t=0 (muted, loop) and is NEVER
  // seeked — the cut between clips is a draw-side crossfade on the cue times.
  const bgUrlKey = (bgVideoUrls ?? []).join('|');
  useEffect(() => {
    const prev = videoElsRef.current;
    videoElsRef.current = [];
    onBgVideosReady?.([]);
    prev.forEach((v) => {
      v.pause();
      v.removeAttribute('src');
      v.load();
    });

    const urls = bgVideoUrls ?? [];
    if (urls.length > 0) {
      const els: HTMLVideoElement[] = [];
      urls.forEach((url) => {
        const v = document.createElement('video');
        v.muted = true;
        v.loop = true;
        (v as any).playsInline = true;
        v.preload = 'auto';
        v.src = url;
        v.load();
        v.play().catch(() => {});
        els.push(v);
      });
      videoElsRef.current = els;
      onBgVideosReady?.(els);
    }
    return () => {
      videoElsRef.current.forEach((v) => v.pause());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bgUrlKey]);

  useEffect(() => {
    if (!analyser || !canvasRef.current || dimensions.w === 0 || dimensions.h === 0) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // We shouldn't store animationId only, but re-trigger
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    // Shared time-domain buffer — circle/alchemy used to allocate a fresh
    // Uint8Array(1024) every frame (GC churn at 60 fps).
    const timeData = new Uint8Array(bufferLength);
    let animationId: number;
    // Frame-jitter PRNG: Math.random() calls inside the draw loops (circle
    // aura, swarm, flight) add up at 60 fps; a cheap LCG gives the same
    // look without the native-call overhead.
    let seed = 0x2f6e2b1;
    const rand = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;

    const flightStars: {x: number, y: number, z: number}[] = [];
    for(let i=0; i<150; i++) {
       flightStars.push({x: Math.random()*2-1, y: Math.random()*2-1, z: Math.random()});
    }

    // Used for swarm (replacing smoke). 40 particles, not 150: each one is a
    // per-frame createRadialGradient (the 150× radial-gradient path was the
    // second-heaviest cost in the visualizer) and 40 still reads as a swarm.
    const swarmParticles: {x: number, y: number, vx: number, vy: number, baseHue: number, size: number}[] = [];
    for(let i=0; i<40; i++) {
       swarmParticles.push({
          x: Math.random(),
          y: Math.random(),
          vx: (Math.random() - 0.5) * 0.002,
          vy: (Math.random() - 0.5) * 0.002,
          baseHue: 190 + Math.random() * 40, // 190-230: blue to cyan
          size: Math.random() * 2 + 1
       });
    }

    const draw = () => {
      animationId = requestAnimationFrame(draw);

      // Black background
      ctx.fillStyle = '#090a0c';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Pexels background clips (export mode): cover-fit under the overlay.
      // With cue times the loop crossfades between clips 0.6 s AFTER each
      // audio peak (k = number of cues at or before t; during the window the
      // next clip fades in over the current one). With any ready clip the
      // standard visualizer is suppressed (bgActive) — only the track title,
      // the cover frame and the credit remain. Not-ready clips drop out of
      // the rotation (readyVids), so a slow download degrades the cut count,
      // never the video.
      const bg = bgStateRef.current;
      const readyVids = videoElsRef.current.filter((v) => v.readyState >= 2 && v.videoWidth > 0 && v.videoHeight > 0);
      const bgActive = exportMode && bg.urls.length > 0 && readyVids.length > 0;
      if (bgActive) {
        const tNow = bg.getTime ? bg.getTime() : 0;
        const cues = bg.cues;
        let k = 0;
        for (let ci = 0; ci < cues.length; ci += 1) {
          if (cues[ci] <= tNow) k += 1; else break;
        }
        const drawVid = (v: HTMLVideoElement, alpha: number) => {
          const vScale = Math.max(canvas.width / v.videoWidth, canvas.height / v.videoHeight);
          const vdw = v.videoWidth * vScale;
          const vd = v.videoHeight * vScale;
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          if (alpha < 1) ctx.globalAlpha = alpha;
          ctx.drawImage(v, (canvas.width - vdw) / 2, (canvas.height - vd) / 2, vdw, vd);
          if (alpha < 1) ctx.globalAlpha = 1;
        };
        const n = readyVids.length;
        if (cues.length > 0 && k >= 1 && tNow - cues[k - 1] < 0.6) {
          const alpha = (tNow - cues[k - 1]) / 0.6;
          drawVid(readyVids[(k - 1) % n], 1);
          drawVid(readyVids[k % n], alpha);
        } else {
          drawVid(readyVids[k % n], 1);
        }
      }

      if (!bgActive && mode === 'bars') {
        analyser.getByteFrequencyData(dataArray);
        // Use exactly the right barWidth to fill the full width. Downsample
        // to ~96 bars: 717 createLinearGradient calls/frame was the heaviest
        // per-frame cost in the whole visualizer and is visually indistinguishable.
        const usable = Math.floor(bufferLength * 0.7); // only lower 70% of spectrum
        const binStep = Math.max(1, Math.floor(usable / 96));
        const visibleBins = Math.floor(usable / binStep);
        const barWidth = canvas.width / visibleBins;
        let x = 0;

        for (let i = 0, b = 0; b < visibleBins; b++, i += binStep) {
          const barHeight = (dataArray[i] / 255) * canvas.height;
          // Use a gradient for bars
          const gradient = ctx.createLinearGradient(0, canvas.height, 0, canvas.height - barHeight);
          gradient.addColorStop(0, '#00ffd2');
          gradient.addColorStop(1, '#0099ff');

          ctx.fillStyle = gradient;
          // Add a tiny gap between bars if barWidth is large enough
          const gap = barWidth > 2 ? 1 : 0;
          ctx.fillRect(x, canvas.height - barHeight, barWidth - gap, barHeight);
          x += barWidth;
        }
      } else if (!bgActive && mode === 'circle') {
        analyser.getByteTimeDomainData(timeData);
        analyser.getByteFrequencyData(dataArray);

        const centerX = canvas.width / 2;
        const centerY = canvas.height / 2;
        const radius = Math.min(centerX, centerY) * 0.35; // keep radius for aura distance
        const imgRadius = radius * 2; // double image size
        
        let localRms = 0;
        for (let i = 0; i < timeData.length; i++) {
          const v = (timeData[i] / 128) - 1;
          localRms += v * v;
        }
        localRms = Math.sqrt(localRms / timeData.length);
        const intensity = Math.min(localRms * 3, 1);

        // Draw center logo/cover
        ctx.save();
        // Add heartbeat scale
        const currentScale = 1.0 + (intensity * 0.15);
        ctx.translate(centerX, centerY);
        ctx.scale(currentScale, currentScale);
        ctx.translate(-centerX, -centerY);

        ctx.beginPath();
        ctx.arc(centerX, centerY, imgRadius, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        if (imageRef.current) {
           const img = imageRef.current;
           const imgAspect = img.width / img.height;
           let dw = imgRadius * 2;
           let dh = imgRadius * 2;
           if (imgAspect > 1) { dw = dh * imgAspect; }
           else { dh = dw / imgAspect; }
           // Add high quality smoothing
           ctx.imageSmoothingEnabled = true;
           ctx.imageSmoothingQuality = 'high';
           // Cover pan: shift the crop inside the overflow (same -1..1
           // value as the UI preview / export frame).
           const offX = imgAspect > 1 ? coverOffset.x * (dw - imgRadius * 2) / 2 : 0;
           const offY = imgAspect < 1 ? coverOffset.y * (dh - imgRadius * 2) / 2 : 0;
           ctx.drawImage(img, centerX - dw/2 + offX, centerY - dh/2 + offY, dw, dh);
        } else {
           // Placeholder Neon Brain Vector
           ctx.fillStyle = '#0a0a0c';
           ctx.fillRect(0,0, canvas.width, canvas.height);
           ctx.font = `bold ${imgRadius * 0.4}px sans-serif`;
           ctx.textAlign = 'center';
           ctx.textBaseline = 'middle';
           ctx.fillStyle = `rgba(0, 255, 255, ${0.5 + intensity*0.5})`;
           ctx.shadowColor = '#00ffff';
           ctx.shadowBlur = 10 + intensity * 20;
           ctx.fillText('NMP', centerX, centerY);
        }
        ctx.restore();

        // Chaotic glitch aura grows from standard radius offset so it surrounds the bigger image nicely or emanates from inside it. 
        // We will push the aura start circle out by radius*1.2 so it peeks out from the big image
        ctx.globalCompositeOperation = 'screen';
        for (let i = 0; i < bufferLength; i += 4) {
          const val = dataArray[i] / 255;
          if (val < 0.1) continue;

          const angle = (i / bufferLength) * Math.PI * 2;
          const glitchOffset = (rand() - 0.5) * intensity * 50;

          const length = val * radius * 1.5 + (rand() < 0.1 ? glitchOffset : 0);
          const startRadius = radius * 1.8 * currentScale;
          const endRadius = (radius * 1.8 + length) * currentScale;

          const x1 = centerX + Math.cos(angle + glitchOffset*0.01) * startRadius;
          const y1 = centerY + Math.sin(angle + glitchOffset*0.01) * startRadius;

          const x2 = centerX + Math.cos(angle) * endRadius;
          const y2 = centerY + Math.sin(angle) * endRadius;

          ctx.strokeStyle = `rgba(0, ${150 + rand()*105}, 255, ${0.4 + val*0.6})`;
          ctx.lineWidth = rand() > 0.9 ? 3 : 1;
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();

          // Glitch disconnected dots
          if (rand() > 0.8 && val > 0.5) {
             ctx.fillStyle = ctx.strokeStyle;
             const px = x2 + Math.cos(angle) * (rand() * 20 + 5);
             const py = y2 + Math.sin(angle) * (rand() * 20 + 5);
             ctx.fillRect(px, py, 2, 2);
          }
        }
        ctx.globalCompositeOperation = 'source-over';
      } else if (!bgActive && mode === 'wave') {
        analyser.getByteTimeDomainData(dataArray);
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#00ffd2';
        ctx.beginPath();

        const sliceWidth = (canvas.width * 1.0) / bufferLength;
        let x = 0;

        for (let i = 0; i < bufferLength; i++) {
          const v = dataArray[i] / 128.0;
          const y = (v * canvas.height) / 2;

          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);

          x += sliceWidth;
        }

        ctx.lineTo(canvas.width, canvas.height / 2);
        ctx.stroke();
      } else if (!bgActive && mode === 'alchemy') {
        analyser.getByteFrequencyData(dataArray);

        // Deep blue background effect
        ctx.fillStyle = 'rgba(5, 10, 20, 0.2)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // (shared `timeData` buffer, allocated once per effect run)
        analyser.getByteTimeDomainData(timeData);
        let rms = 0;
        for (let i = 0; i < timeData.length; i++) {
          const v = (timeData[i] / 128) - 1;
          rms += v * v;
        }
        rms = Math.sqrt(rms / timeData.length);

        // Draw multiple "oil spots"
        ctx.globalCompositeOperation = 'screen';
        const numSpots = 8;
        for (let i = 0; i < numSpots; i++) {
          const freqRangeStart = Math.floor(i * (dataArray.length / numSpots));
          let intensity = 0;
          for(let j=0; j<20; j++) intensity += dataArray[freqRangeStart + j] || 0;
          intensity = (intensity / 20) / 255;
          
          // Organic movement
          const slowTime = Date.now() * 0.0005;
          const x = (canvas.width / 2) + Math.sin(slowTime + i * 1.5) * (canvas.width * 0.3);
          const y = (canvas.height / 2) + Math.cos(slowTime * 0.8 + i) * (canvas.height * 0.3);
          
          const baseSize = 50 + i * 20;
          const size = baseSize + intensity * 150 + rms * 200;

          const grad = ctx.createRadialGradient(x, y, size * 0.1, x, y, size);
          // Alchemy palette: Blues, Cyans, Deep Purples
          const hue = 200 + Math.sin(slowTime + i) * 30; // 170-230 range (Cyan to Blue)
          grad.addColorStop(0, `hsla(${hue}, 100%, 60%, ${0.6 * intensity + 0.1})`);
          grad.addColorStop(0.5, `hsla(${hue + 20}, 80%, 40%, ${0.3 * intensity})`);
          grad.addColorStop(1, 'rgba(0, 0, 0, 0)');

          ctx.fillStyle = grad;
          ctx.beginPath();
          // Slightly non-circular for "oil" feel
          const stretchX = 1 + Math.sin(slowTime * 2 + i) * 0.2;
          const stretchY = 1 + Math.cos(slowTime * 2 + i) * 0.2;
          ctx.ellipse(x, y, size * stretchX, size * stretchY, slowTime + i, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalCompositeOperation = 'source-over';
      } else if (!bgActive && mode === 'circles') {
        analyser.getByteFrequencyData(dataArray);
        ctx.fillStyle = 'rgba(5, 10, 15, 0.2)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        const cx = canvas.width / 2;
        const cy = canvas.height / 2;
        const time = Date.now() * 0.001;
        ctx.globalCompositeOperation = 'screen';
        
        for (let c = 1; c <= 8; c++) {
          ctx.beginPath();
          const radiusBase = c * Math.min(cx, cy) * 0.1;
          for (let a = 0; a <= Math.PI * 2; a += 0.1) {
            const bin = Math.floor((a / (Math.PI * 2)) * bufferLength * 0.5) % bufferLength;
            const val = dataArray[bin] / 255.0;
            // Bizarre warping effect based on frequency
            const distortion = Math.sin(a * (3 + c) + time) * 20 * val + Math.cos(a * 5 - time * 2) * 10 * val;
            const r = radiusBase + distortion * (c * 0.8);
            
            const dir = c % 2 === 0 ? 1 : -1;
            const x = cx + Math.cos(a + time * 0.2 * dir) * r;
            const y = cy + Math.sin(a + time * 0.2 * dir) * r;
            
            if (a === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.closePath();
          // Neon blue/cyan styling. Glow is faked with a wide translucent
          // under-stroke: shadowBlur forces a gaussian pass per stroke and
          // was the slowest path in this mode.
          const glowAlpha = (0.2 + (dataArray[c*5]/255)*0.8) * 0.35;
          ctx.strokeStyle = `hsla(190, 100%, ${55 + c * 5}%, ${glowAlpha})`;
          ctx.lineWidth = (2 + (dataArray[c*3]/255) * 3) + 6;
          ctx.stroke();
          ctx.strokeStyle = `hsla(190, 100%, ${50 + c * 5}%, ${0.2 + (dataArray[c*5]/255)*0.8})`;
          ctx.lineWidth = 2 + (dataArray[c*3]/255) * 3;
          ctx.stroke();
        }
        ctx.globalCompositeOperation = 'source-over';
      } else if (!bgActive && mode === 'flight') {
        analyser.getByteFrequencyData(dataArray);
        ctx.fillStyle = 'rgba(2, 6, 12, 0.3)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        const cx = canvas.width / 2;
        const cy = canvas.height / 2;
        
        // Calculate bass energy for speed
        let bass = 0;
        for (let i = 0; i < 10; i++) bass += dataArray[i];
        bass = (bass / 10) / 255.0;
        const speed = 0.005 + bass * 0.05;

        ctx.globalCompositeOperation = 'screen';
        flightStars.forEach(star => {
          star.z -= speed;
          if (star.z <= 0) {
            star.x = rand() * 2 - 1;
            star.y = rand() * 2 - 1;
            star.z = 1;
          }
          
          const px = cx + (star.x / star.z) * cx;
          const py = cy + (star.y / star.z) * cy;
          const pz = 1 - star.z; // Inverse z for brightness/size
          
          const prevZ = star.z + speed;
          const prevPx = cx + (star.x / prevZ) * cx;
          const prevPy = cy + (star.y / prevZ) * cy;

          // Motion trail
          ctx.beginPath();
          ctx.moveTo(prevPx, prevPy);
          ctx.lineTo(px, py);
          ctx.strokeStyle = `hsla(200, 100%, ${50 + pz * 50}%, ${pz})`;
          ctx.lineWidth = pz * 3 + bass * 2;
          ctx.stroke();
          
          // Star core
          ctx.beginPath();
          ctx.arc(px, py, pz * 2 + bass * 1.5, 0, Math.PI * 2);
          ctx.fillStyle = '#00ffd2';
          ctx.fill();
        });
        ctx.globalCompositeOperation = 'source-over';
      } else if (!bgActive && mode === 'smoke') {
        // Redefined "smoke" to "Neon Swarm / Fireflies"
        analyser.getByteFrequencyData(dataArray);
        ctx.fillStyle = 'rgba(2, 5, 12, 0.25)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        ctx.globalCompositeOperation = 'screen';
        const cx = canvas.width / 2;
        const cy = canvas.height / 2;
        
        swarmParticles.forEach((p, i) => {
           // Mapping each particle to a frequency bin
           const bin = Math.floor(i * (bufferLength * 0.5) / swarmParticles.length);
           const val = dataArray[bin] / 255.0;
           
           // Particle behavior: vibrate based on audio
           p.x += p.vx + (rand() - 0.5) * val * 0.02;
           p.y += p.vy + (rand() - 0.5) * val * 0.02;
           
           // Wrap around
           if (p.x < 0) p.x = 1; if (p.x > 1) p.x = 0;
           if (p.y < 0) p.y = 1; if (p.y > 1) p.y = 0;
           
           // Subtle drift and noise Instead of rigid center orbit
           if (val > 0.3) {
             const cxTarget = 0.5 + Math.sin(Date.now() * 0.001 + i) * 0.3;
             const cyTarget = 0.5 + Math.cos(Date.now() * 0.001 + i) * 0.3;
             const dx = cxTarget - p.x;
             const dy = cyTarget - p.y;
             p.vx += dx * 0.001;
             p.vy += dy * 0.001;
           }
           
           // Apply dampening
           p.vx *= 0.95;
           p.vy *= 0.95;
           
           const px = p.x * canvas.width;
           const py = p.y * canvas.height;
           const size = p.size * (1 + val * 4); // Pulse
           
           // Draw trailing glow
           ctx.beginPath();
           const grad = ctx.createRadialGradient(px, py, 0, px, py, size * 3);
           grad.addColorStop(0, `hsla(${p.baseHue}, 100%, 70%, ${0.8 + val * 0.2})`);
           grad.addColorStop(0.3, `hsla(${p.baseHue}, 100%, 50%, ${0.3 + val * 0.5})`);
           grad.addColorStop(1, 'rgba(0,0,0,0)');
           
           ctx.fillStyle = grad;
           ctx.arc(px, py, size * 3, 0, Math.PI * 2);
           ctx.fill();
           
           // Draw bright core
           ctx.beginPath();
           ctx.fillStyle = '#00ffff';
           ctx.arc(px, py, size * 0.4, 0, Math.PI * 2);
           ctx.fill();
           
           // Draw connection lines if nearby and loud
           if (i > 0 && val > 0.6) {
              const prev = swarmParticles[i - 1];
              const prevPx = prev.x * canvas.width;
              const prevPy = prev.y * canvas.height;
              const dist = Math.hypot(px - prevPx, py - prevPy);
              
              if (dist < canvas.width * 0.15) {
                ctx.beginPath();
                ctx.moveTo(prevPx, prevPy);
                ctx.lineTo(px, py);
                ctx.strokeStyle = `hsla(${p.baseHue}, 100%, 60%, ${val * 0.5})`;
                ctx.lineWidth = 1;
                ctx.stroke();
              }
           }
        });
        
        ctx.globalCompositeOperation = 'source-over';
      }
      // End of main visualizer loops
      if (exportMode) {
        // Draw track metadata overlay for videos
        const titleText = metadata?.title || 'Unknown Track';
        
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        // Base sizes dynamically on canvas size
        const fontSize = Math.max(canvas.height * 0.03, 24);
        // Lift text and frame by 10%
        const paddingBottom = canvas.height * 0.15;
        
        ctx.font = `bold ${fontSize}px sans-serif`;
        ctx.fillStyle = '#00ffd2'; // text same as frame color
        ctx.shadowColor = '#000';
        ctx.shadowBlur = 10;
        ctx.fillText(titleText, canvas.width / 2, canvas.height - paddingBottom);
        ctx.shadowBlur = 0; // Reset

        // If not glitch mode, draw the frame and photo. In the Pexels
        // background the frame is the "album logo" the user keeps — always
        // drawn there, whatever the visualizer mode is.
        if (mode !== 'circle' || bgActive) {
          // Image frame (aiming for roughly ~20% of canvas area)
          const area = canvas.width * canvas.height;
          let imgSize = Math.sqrt(area * 0.20);
          // Constrain to not break the layout for odd aspect ratios
          imgSize = Math.min(imgSize, canvas.width * 0.8, canvas.height * 0.5);

          const imgX = canvas.width / 2 - imgSize / 2;
          const imgY = canvas.height - paddingBottom - fontSize - imgSize - (canvas.height * 0.02);

          // Draw neon frame
          ctx.strokeStyle = '#00ffd2'; // var(--accent)
          ctx.lineWidth = Math.max(canvas.width * 0.005, 3);
          ctx.shadowColor = '#00ffd2';
          ctx.shadowBlur = 25;
          ctx.strokeRect(imgX, imgY, imgSize, imgSize);
          ctx.shadowBlur = 0;

          // Draw the image or program logo placeholder inside the frame
          ctx.save();
          ctx.beginPath();
          ctx.rect(imgX, imgY, imgSize, imgSize);
          ctx.clip();
          if (imageRef.current) {
            const img = imageRef.current;
            const imgAspect = img.width / img.height;
            let dw = imgSize;
            let dh = imgSize;
            if (imgAspect > 1) { dw = dh * imgAspect; }
            else { dh = dw / imgAspect; }
            // Cover pan: shift the crop inside the overflow (same -1..1
            // value as the UI preview / circle mode).
            const offX = imgAspect > 1 ? coverOffset.x * (dw - imgSize) / 2 : 0;
            const offY = imgAspect < 1 ? coverOffset.y * (dh - imgSize) / 2 : 0;
            ctx.drawImage(img, imgX - (dw - imgSize) / 2 + offX, imgY - (dh - imgSize) / 2 + offY, dw, dh);
          } else {
            ctx.fillStyle = '#0a0a0c';
            ctx.fillRect(imgX, imgY, imgSize, imgSize);
            ctx.fillStyle = '#00ffd2';
            ctx.font = `bold ${imgSize * 0.3}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('NMP', imgX + imgSize / 2, imgY + imgSize / 2);
          }
          ctx.restore();
        }

        // Pexels credit line (bottom-right corner)
        if (creditText) {
          const creditSize = Math.max(canvas.height * 0.01, 16);
          const creditMargin = Math.max(canvas.width * 0.015, 30);
          ctx.font = `${creditSize}px sans-serif`;
          ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
          ctx.textAlign = 'right';
          ctx.textBaseline = 'bottom';
          ctx.fillText(creditText, canvas.width - creditMargin, canvas.height - creditMargin);
        }
      }

    };

    draw();
    return () => cancelAnimationFrame(animationId);
  }, [analyser, mode, exportMode, metadata, dimensions, coverOffset]);

  return (
    <div ref={containerRef} className="w-full h-full relative rounded-lg bg-[#151619] overflow-hidden flex items-center justify-center">
      <canvas 
        ref={canvasRef} 
        className="block"
        width={dimensions.w}
        height={dimensions.h}
      />
    </div>
  );
};
