import("stdfaust.lib");

// --- Mastering Chain Parameters ---
// Parameters wrapped in "mastering" vgroup for consistent UI pathing
ui(x) = vgroup("mastering", x);

gain = ui(hslider("gain", 0, -18, 18, 0.01)) : ba.db2linear;
lowShelf = ui(hslider("lowShelf", 0, -10, 10, 0.01));
midRange = ui(hslider("midRange", 0, -10, 10, 0.01));
highShelf = ui(hslider("highShelf", 0, -10, 10, 0.01));
compression = ui(hslider("compression", 0, -5, 5, 0.01)); 
limiterParam = ui(hslider("limiter", 0, -5, 5, 0.01)); 
saturationAmt = ui(hslider("saturation", 0, -10, 10, 0.01)); 
exciterAmount = ui(hslider("exciterAmount", 0, -10, 10, 0.01));
exciterFreq = ui(hslider("exciterFreq", 5000, 3000, 10000, 1));
haasAmount = ui(hslider("haasAmount", 0, -100, 100, 0.01)); 
stereoWidth = ui(hslider("stereoWidth", 0, -100, 100, 0.01));
fundamentalFreq = ui(hslider("fundamentalFreq", 60, 20, 200, 0.01));

// Graphic EQ parameters
eq31 = ui(vslider("eq31", 0, -12, 12, 0.01));
eq62 = ui(vslider("eq62", 0, -12, 12, 0.01));
eq125 = ui(vslider("eq125", 0, -12, 12, 0.01));
eq250 = ui(vslider("eq250", 0, -12, 12, 0.01));
eq500 = ui(vslider("eq500", 0, -12, 12, 0.01));
eq1k = ui(vslider("eq1k", 0, -12, 12, 0.01));
eq2k = ui(vslider("eq2k", 0, -12, 12, 0.01));
eq4k = ui(vslider("eq4k", 0, -12, 12, 0.01));
eq8k = ui(vslider("eq8k", 0, -12, 12, 0.01));
eq16k = ui(vslider("eq16k", 0, -12, 12, 0.01));

autotuneAmt = ui(hslider("autotune", 0, 0, 100, 0.1));
reverbAmt = ui(hslider("reverb", 0, 0, 100, 0.1));
distortionAmt = ui(hslider("distortion", 0, 0, 100, 0.1));
delayAmt = ui(hslider("delay", 0, 0, 100, 0.1));
chorusAmt = ui(hslider("chorus", 0, 0, 100, 0.1));

bass_autotuneAmt = ui(hslider("bass_autotune", 0, 0, 100, 0.1));
bass_reverbAmt = ui(hslider("bass_reverb", 0, 0, 100, 0.1));
bass_distortionAmt = ui(hslider("bass_distortion", 0, 0, 100, 0.1));
bass_delayAmt = ui(hslider("bass_delay", 0, 0, 100, 0.1));
bass_chorusAmt = ui(hslider("bass_chorus", 0, 0, 100, 0.1));

mid_autotuneAmt = ui(hslider("mid_autotune", 0, 0, 100, 0.1));
mid_reverbAmt = ui(hslider("mid_reverb", 0, 0, 100, 0.1));
mid_distortionAmt = ui(hslider("mid_distortion", 0, 0, 100, 0.1));
mid_delayAmt = ui(hslider("mid_delay", 0, 0, 100, 0.1));
mid_chorusAmt = ui(hslider("mid_chorus", 0, 0, 100, 0.1));

side_autotuneAmt = ui(hslider("side_autotune", 0, 0, 100, 0.1));
side_reverbAmt = ui(hslider("side_reverb", 0, 0, 100, 0.1));
side_distortionAmt = ui(hslider("side_distortion", 0, 0, 100, 0.1));
side_delayAmt = ui(hslider("side_delay", 0, 0, 100, 0.1));
side_chorusAmt = ui(hslider("side_chorus", 0, 0, 100, 0.1));

vocal_autotuneAmt = ui(hslider("vocal_autotune", 0, 0, 100, 0.1));
vocal_reverbAmt = ui(hslider("vocal_reverb", 0, 0, 100, 0.1));
vocal_distortionAmt = ui(hslider("vocal_distortion", 0, 0, 100, 0.1));
vocal_delayAmt = ui(hslider("vocal_delay", 0, 0, 100, 0.1));
vocal_chorusAmt = ui(hslider("vocal_chorus", 0, 0, 100, 0.1));

// Stem solo: 0 = master (all stems), 1 = bass, 2 = vocal, 3 = mid, 4 = side
stem_solo = ui(hslider("stem_solo", 0, 0, 4, 1));

// Parametric EQ parameters (4 bands)
// type: 0 = peak, 1 = low shelf, 2 = high shelf
// freq slider 0..100 maps logarithmically to 20 Hz .. 20 kHz
peq1Freq = ui(hslider("peq1Freq", 15, 0, 100, 0.1));
peq1Q = ui(hslider("peq1Q", 1, 0.1, 10, 0.1));
peq1Gain = ui(hslider("peq1Gain", 0, -12, 12, 0.01));
peq1Type = ui(hslider("peq1Type", 0, 0, 2, 1));
peq2Freq = ui(hslider("peq2Freq", 40, 0, 100, 0.1));
peq2Q = ui(hslider("peq2Q", 1, 0.1, 10, 0.1));
peq2Gain = ui(hslider("peq2Gain", 0, -12, 12, 0.01));
peq2Type = ui(hslider("peq2Type", 0, 0, 2, 1));
peq3Freq = ui(hslider("peq3Freq", 65, 0, 100, 0.1));
peq3Q = ui(hslider("peq3Q", 1, 0.1, 10, 0.1));
peq3Gain = ui(hslider("peq3Gain", 0, -12, 12, 0.01));
peq3Type = ui(hslider("peq3Type", 0, 0, 2, 1));
peq4Freq = ui(hslider("peq4Freq", 85, 0, 100, 0.1));
peq4Q = ui(hslider("peq4Q", 1, 0.1, 10, 0.1));
peq4Gain = ui(hslider("peq4Gain", 0, -12, 12, 0.01));
peq4Type = ui(hslider("peq4Type", 0, 0, 2, 1));

// Widener / MONO (stereo image, after ms_wid)
widenerAmt = ui(hslider("widenerAmt", 0, 0, 100, 0.1));
mono = ui(hslider("mono", 0, 0, 1, 1));

// Bus compressor (glue, after multiband)
compAmt = ui(hslider("compAmt", 0, 0, 100, 0.1));
compThresh = ui(hslider("compThresh", -18, -40, 0, 0.5));
compRatio = ui(hslider("compRatio", 3, 1, 20, 0.1));
compAttack = ui(hslider("compAttack", 10, 1, 100, 1));
compRelease = ui(hslider("compRelease", 150, 30, 500, 1));

// Noise gate (opens instantly, closes with one-pole release)
gateAmt = ui(hslider("gateAmt", 0, 0, 100, 0.1));
gateThresh = ui(hslider("gateThresh", -48, -60, 0, 0.5));
gateRelease = ui(hslider("gateRelease", 100, 20, 500, 1));

// Transient shaper (fast/slow split)
transAmt = ui(hslider("transAmt", 0, -100, 100, 0.1));
transFreq = ui(hslider("transFreq", 250, 50, 1000, 1));

// De-esser / tape / air
deessAmt = ui(hslider("deessAmt", 0, 0, 100, 0.1));
deessFreq = ui(hslider("deessFreq", 6000, 4000, 9000, 50));
tapeAmt = ui(hslider("tapeAmt", 0, 0, 100, 0.1));
tapeTone = ui(hslider("tapeTone", 6000, 1000, 12000, 50));
airAmt = ui(hslider("airAmt", 0, 0, 100, 0.1));
airFreq = ui(hslider("airFreq", 8000, 5000, 12000, 50));

// Mod FX (phaser / flanger / tremolo)
phaserAmt = ui(hslider("phaserAmt", 0, 0, 100, 0.1));
flangerAmt = ui(hslider("flangerAmt", 0, 0, 100, 0.1));
tremoloAmt = ui(hslider("tremoloAmt", 0, 0, 100, 0.1));

// Bitcrusher
bitDepth = ui(hslider("bitDepth", 16, 4, 16, 1));
srHold = ui(hslider("srHold", 1, 1, 20, 1));

// --- 1. EQ SECTION ---
graphic_eq = fi.peak_eq(eq31, 31, 31/1.414)
           : fi.peak_eq(eq62, 62, 62/1.414)
           : fi.peak_eq(eq125, 125, 125/1.414)
           : fi.peak_eq(eq250, 250, 250/1.414)
           : fi.peak_eq(eq500, 500, 500/1.414)
           : fi.peak_eq(eq1k, 1000, 1000/1.414)
           : fi.peak_eq(eq2k, 2000, 2000/1.414)
           : fi.peak_eq(eq4k, 4000, 4000/1.414)
           : fi.peak_eq(eq8k, 8000, 8000/1.414)
           : fi.peak_eq(eq16k, 16000, 16000/1.414);

eq_stage = fi.low_shelf(lowShelf, 150)
         : fi.peak_eq(midRange, 1000, 1000/1.0)
         : fi.high_shelf(highShelf, 5000)
         : fi.peak_eq(3.0, fundamentalFreq, fundamentalFreq/8.0)
         : graphic_eq;

// --- 1b. PARAMETRIC EQ (4 bands: peak / low shelf / high shelf) ---
// Type switch uses smooth arithmetic weights (no select2/ba.if — see haas_node
// comment). At gain=0 every band is a pure bypass.
peq1(x) = (x : fi.peak_eq_cq(peq1Gain, peq1_hz, peq1Q) * peq1_wp)
         + (x : fi.low_shelf(peq1Gain, peq1_hz) * peq1_wn)
         + (x : fi.high_shelf(peq1Gain, peq1_hz) * peq1_wh)
with {
    peq1_hz = 20.0 * pow(10.0, 3.0 * (peq1Freq / 100.0));
    peq1_wp = 1.0 - min(1.0, max(0.0, (peq1Type - 0.5) * 10.0));
    peq1_wn = min(1.0, max(0.0, (peq1Type - 0.5) * 10.0)) * (1.0 - min(1.0, max(0.0, (peq1Type - 1.5) * 10.0)));
    peq1_wh = min(1.0, max(0.0, (peq1Type - 1.5) * 10.0));
};

peq2(x) = (x : fi.peak_eq_cq(peq2Gain, peq2_hz, peq2Q) * peq2_wp)
         + (x : fi.low_shelf(peq2Gain, peq2_hz) * peq2_wn)
         + (x : fi.high_shelf(peq2Gain, peq2_hz) * peq2_wh)
with {
    peq2_hz = 20.0 * pow(10.0, 3.0 * (peq2Freq / 100.0));
    peq2_wp = 1.0 - min(1.0, max(0.0, (peq2Type - 0.5) * 10.0));
    peq2_wn = min(1.0, max(0.0, (peq2Type - 0.5) * 10.0)) * (1.0 - min(1.0, max(0.0, (peq2Type - 1.5) * 10.0)));
    peq2_wh = min(1.0, max(0.0, (peq2Type - 1.5) * 10.0));
};

peq3(x) = (x : fi.peak_eq_cq(peq3Gain, peq3_hz, peq3Q) * peq3_wp)
         + (x : fi.low_shelf(peq3Gain, peq3_hz) * peq3_wn)
         + (x : fi.high_shelf(peq3Gain, peq3_hz) * peq3_wh)
with {
    peq3_hz = 20.0 * pow(10.0, 3.0 * (peq3Freq / 100.0));
    peq3_wp = 1.0 - min(1.0, max(0.0, (peq3Type - 0.5) * 10.0));
    peq3_wn = min(1.0, max(0.0, (peq3Type - 0.5) * 10.0)) * (1.0 - min(1.0, max(0.0, (peq3Type - 1.5) * 10.0)));
    peq3_wh = min(1.0, max(0.0, (peq3Type - 1.5) * 10.0));
};

peq4(x) = (x : fi.peak_eq_cq(peq4Gain, peq4_hz, peq4Q) * peq4_wp)
         + (x : fi.low_shelf(peq4Gain, peq4_hz) * peq4_wn)
         + (x : fi.high_shelf(peq4Gain, peq4_hz) * peq4_wh)
with {
    peq4_hz = 20.0 * pow(10.0, 3.0 * (peq4Freq / 100.0));
    peq4_wp = 1.0 - min(1.0, max(0.0, (peq4Type - 0.5) * 10.0));
    peq4_wn = min(1.0, max(0.0, (peq4Type - 0.5) * 10.0)) * (1.0 - min(1.0, max(0.0, (peq4Type - 1.5) * 10.0)));
    peq4_wh = min(1.0, max(0.0, (peq4Type - 1.5) * 10.0));
};

peq_chain = peq1 : peq2 : peq3 : peq4;

// --- 1c. NOISE GATE (before compression: cuts silence, not dynamics) ---
// Attack 2 ms, release = gateRelease ms (stdlib one-pole switching; the
// faustwasm 0.16.1 compiler miscompiles hand-written self-referencing
// with-blocks — "endless evaluation cycle" — so no manual follower here).
lin2db(x) = ba.linear2db(x);
gate_node(x) = x * g
with {
    env_db = x : an.amp_follower_ar(0.002, gateRelease / 1000.0) : lin2db;
    s = (env_db - gateThresh) : max(0) : min(1);
    g = 1.0 - (gateAmt / 100.0) * (1.0 - s);
};

// --- 1c2. DE-ESSER (ducks only the sibilance band; def amt=0 -> x) ---
deess_node(x) = x - sib * duck
with {
    sib = x : fi.bandpass(2, deessFreq * 0.83, deessFreq * 1.17);
    env = sib : an.rms_envelope_rect(0.02) : max(0) : min(1.0);
    duck = env * (deessAmt / 100.0);
};

// --- 1d. TRANSIENT SHAPER (fast/slow split, amplitude-dependent) ---
trans_node(x) = slow + fast * (1.0 + t * env)
with {
    t = transAmt / 100.0;
    slow = x : fi.lowpass(1, transFreq);
    fast = x - slow;
    env = x : an.rms_envelope_rect(0.01) : max(0) : min(1.0);
};

// --- 1e. BUS COMPRESSOR (glue; wet/dry, def amt=0 -> dry) ---
bus_comp(x) = (x * (1.0 - a)) + (x : co.compressor_mono(compRatio, compThresh, compAtk_s, compRel_s))
with {
    a = compAmt / 100.0;
    compAtk_s = compAttack / 1000.0;
    compRel_s = compRelease / 1000.0;
};

// --- 1f. TAPE SATURATION (tanh drive + "tape" lowpass; def amt=0 -> x) ---
tape_node(x) = x * (1.0 - a) + (x : tape_sat) * a
with { a = tapeAmt / 100.0; };
tape_sat(y) = y : fi.lowpass(2, tapeTone) : ma.tanh : *(3.0) : *(1.0/1.5);

// --- 4a. MOD FX (creative; all def amt=0 -> x; LFOs start phase-locked) ---
// PHASER — 4 allpass stages, delay LFO 1.5..5 ms @ 0.25 Hz
phaser_node(x) = x * (1.0 - w) + (x : ap : ap : ap : ap) * w
with {
    w = phaserAmt / 100.0 * 0.7;
    d = (0.0015 + 0.0035 * (os.osc(0.25) * 0.5 + 0.5)) * ma.SR;
    ap = fi.allpass_comb((ma.SR / 100.0) * 8, d, 0.6);
};

// FLANGER — modulated delay 1..10 ms @ 0.3 Hz + feedback 0.5.
// Feedback uses the stdlib-verified `loop ~ _` idiom (onePoleSwitching shape):
// yState is the previous sample of the result. The faustwasm 0.16.1 compiler
// miscompiles hand-written self-referencing with-blocks, so no `y with {...}`.
flanger_node(x) = x * (1.0 - w) + flange_fb * w
with {
    w = flangerAmt / 100.0 * 0.5;
    flange_fb = loop ~ _
    with {
        loop(yState) = (yState : fd) : *(0.5) + x : fd
        with {
            fd = de.fdelay((ma.SR / 100.0) * 6, d);
            d = (0.001 + 0.009 * (os.osc(0.3) * 0.5 + 0.5)) * ma.SR;
        };
    };
};

// TREMOLO — AM 4 Hz, depth up to 85%
tremolo_node(x) = x * (1.0 - a * 0.85 + a * 0.85 * (os.osc(4.0) * 0.5 + 0.5))
with { a = tremoloAmt / 100.0; };

// --- 4a2. AIR EXCITER (hp -> tanh -> blend; def amt=0 -> x) ---
air_node(x) = x + (x : fi.highpass(2, airFreq) : ma.tanh : *(a * 0.5))
with { a = airAmt / 100.0 : max(0); };

// --- 4c. BITCRUSHER (quantization + sample-and-hold; def 16 bit / hold=1
// = 16-bit quantization only, deviation <= 1.5e-5, inaudible) ---
// `loop ~ _` idiom (faustwasm 0.16.1 miscompiles hand-written
// self-referencing with-blocks — see flanger_node comment).
crush_node(x) = hold
with {
    q = pow(2.0, bitDepth - 1.0);
    k = 1.0 / srHold;
    qround = x : *(q) : round : *(1.0/q);
    hold = loop ~ _
    with {
        loop(yState) = k * qround + (1.0 - k) * yState;
    };
};

// --- 4b. WIDENER + MONO (stereo 2-in/2-out; def: s*(1+0)*(1-0) = s) ---
wid_mono(l_in, r_in) = (m + s_out), (m - s_out)
with {
    m = (l_in + r_in) * 0.5;
    s = (l_in - r_in) * 0.5;
    s_out = s * (1.0 + widenerAmt / 100.0) * (1.0 - mono);
};

// --- 2. TEXTURE SECTION ---
dist(x) = ma.tanh(x * (1.0 + drv)) / (1.0 + drv * 0.5) with { drv = (saturationAmt / 10.0) * 4.0 : max(0); };
excite(x) = x + (x : fi.highpass(2, exciterFreq) : dist : *(exc_lvl)) with { exc_lvl = (exciterAmount / 10.0) * 0.5 : max(0); };

// --- 3. DYNAMICS SECTION ---
mb_comp = _ <: (fi.lowpass(3, 250), mid_belt, fi.highpass(3, 3300)) : (comp, comp, comp) :> _
with {
    mid_belt = fi.highpass(3, 250) : fi.lowpass(3, 3300);
    comp = co.compressor_mono(ratio, thresh, 0.01, 0.15)
    with {
        ratio = 2.0 + (compression : max(0));
        thresh = -12.0 - (compression * 10.0);
    };
};

// --- 4. SPATIAL SECTION ---
// Mathematical Haas routing to avoid select2/ba.if evaluation errors entirely
haas_l(x) = x : de.delay(0.2 * ma.SR, max(0, -haasAmount) / 1000.0 * ma.SR);
haas_r(x) = x : de.delay(0.2 * ma.SR, max(0, haasAmount) / 1000.0 * ma.SR);

haas_node(l, r) = haas_l(l), haas_r(r);

// Manual MS Matrix to avoid "undefined symbol" errors
ms_wid(l, r) = (m + s_adj), (m - s_adj)
with {
    m = (l + r) * 0.5;
    s = (l - r) * 0.5;
    s_adj = s * (1.0 + (stereoWidth / 100.0));
};

// --- 5. LIMITER SECTION ---
limit_node = *(pushed) : co.compressor_mono(20, -0.2, 0.002, 0.1)
with {
    pushed = limiterParam : max(0) : ba.db2linear;
};

// --- 4.5 NEW EFFECTS SECTION (ALGORITHMIC STEM SEPARATION) ---
fx_dist_mono(d_amt, x) = x * (1.0 - d) + (x * (1.0 + d * 15.0) : ma.tanh : /(1.0 + d * 3.0)) * d with { d = d_amt / 100.0; };
fx_auto_mono(a_amt, x) = x * (1.0 - a) + (x : fi.lowpass(2, 4000) * os.osc(261.63) : fi.highpass(2, 300)) * a with { a = a_amt / 100.0; };
fx_delay_mono(del_amt, x) = x + (x : de.fdelay(48000, 48000*0.375) * (del_amt / 100.0 * 0.4));
fx_chorus_mono(c_amt, x) = x * (1.0 - c) + (x : de.fdelay(48000, 48000*(0.015 + 0.005*os.osc(1.5)))) * c with { c = c_amt / 100.0; };

fx_chain_mono(d_a, a_a, del_a, c_a, x) = x : fx_dist_mono(d_a) : fx_auto_mono(a_a) : fx_delay_mono(del_a) : fx_chorus_mono(c_a);

fx_reverb_stereo(r_amt) = _,_ <: ( (re.zita_rev1_stereo(20,200,6000,1.2,1.5,48000) : *(rV), *(rV)) , (_,_) ) :> _,_
with { rV = r_amt / 100.0 * 0.5; };

stem_crossover(l_in, r_in) = ((bass_stereo : solo_gate(1)), (vocal_stereo : solo_gate(2)), (mid_stereo : solo_gate(3)), (side_stereo : solo_gate(4))) :> _,_
with {
    m_raw = (l_in + r_in) * 0.5;
    s_raw = (l_in - r_in) * 0.5;

    // Perfect reconstruction crossover using subtraction.
    // Vocal band (200 Hz–8 kHz) is carved out of the center as its own stem;
    // bass + vocal + mid_body still sum back to m_raw.
    bass_clean = m_raw : fi.lowpass(2, 120);
    mid_clean = m_raw - bass_clean;
    vocal_clean = mid_clean : fi.highpass(2, 200) : fi.lowpass(2, 8000);
    mid_body = mid_clean - vocal_clean;
    side_clean = s_raw;

    // Stem Mono Chains
    bass_fx = bass_clean : fx_chain_mono(bass_distortionAmt, bass_autotuneAmt, bass_delayAmt, bass_chorusAmt);
    vocal_fx = vocal_clean : fx_chain_mono(vocal_distortionAmt, vocal_autotuneAmt, vocal_delayAmt, vocal_chorusAmt);
    mid_fx = mid_body : fx_chain_mono(mid_distortionAmt, mid_autotuneAmt, mid_delayAmt, mid_chorusAmt);
    side_fx = side_clean : fx_chain_mono(side_distortionAmt, side_autotuneAmt, side_delayAmt, side_chorusAmt);

    // Stem Stereo Paths (Core + Reverb)
    // fx_reverb_stereo internally passes the dry signal alongside the wet,
    // so we don't need to reconstruct the core manually.
    bass_stereo = (bass_fx, bass_fx) : fx_reverb_stereo(bass_reverbAmt);
    vocal_stereo = (vocal_fx, vocal_fx) : fx_reverb_stereo(vocal_reverbAmt);
    mid_stereo  = (mid_fx, mid_fx)   : fx_reverb_stereo(mid_reverbAmt);
    side_stereo = (side_fx, side_fx * -1.0) : fx_reverb_stereo(side_reverbAmt);

    // Solo gate: stem n passes when stem_solo is 0 (master) or n.
    // One-pole smoothing (crush_node `loop ~ _` idiom — fi.smooth is not
    // exposed in faustwasm 0.16.1 signals.lib) avoids clicks on solo toggles.
    solo_gate(n) = par(i, 2, *(gate)) with {
        want = (stem_solo == 0) + (stem_solo == n);
        kk = 0.01;
        gate = loop ~ _
        with {
            loop(yState) = kk * want + (1.0 - kk) * yState;
        };
    };
};

fx_master = (process_chan, process_chan) : fx_reverb_stereo(reverbAmt)
with {
    process_chan = fx_chain_mono(distortionAmt, autotuneAmt, delayAmt, chorusAmt);
};

// --- MAIN PROCESSING CHAIN ---
process =
    par(i, 2, *(gain))
    : par(i, 2, eq_stage)
    : par(i, 2, gate_node)
    : par(i, 2, deess_node)
    : par(i, 2, peq_chain)
    : stem_crossover
    : fx_master
    : par(i, 2, trans_node)
    : par(i, 2, dist : excite)
    : par(i, 2, mb_comp)
    : par(i, 2, bus_comp)
    : par(i, 2, tape_node)
    : haas_node
    : par(i, 2, phaser_node)
    : par(i, 2, flanger_node)
    : par(i, 2, tremolo_node)
    : ms_wid
    : wid_mono
    : par(i, 2, air_node)
    : par(i, 2, crush_node)
    : par(i, 2, limit_node);
