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

stem_crossover(l_in, r_in) = (bass_stereo, mid_stereo, side_stereo) :> _,_
with {
    m_raw = (l_in + r_in) * 0.5;
    s_raw = (l_in - r_in) * 0.5;

    // Perfect reconstruction crossover using subtraction
    bass_clean = m_raw : fi.lowpass(2, 120);
    mid_clean = m_raw - bass_clean;
    side_clean = s_raw;

    // Stem Mono Chains
    bass_fx = bass_clean : fx_chain_mono(bass_distortionAmt, bass_autotuneAmt, bass_delayAmt, bass_chorusAmt);
    mid_fx = mid_clean : fx_chain_mono(mid_distortionAmt, mid_autotuneAmt, mid_delayAmt, mid_chorusAmt);
    side_fx = side_clean : fx_chain_mono(side_distortionAmt, side_autotuneAmt, side_delayAmt, side_chorusAmt);

    // Stem Stereo Paths (Core + Reverb)
    // fx_reverb_stereo internally passes the dry signal alongside the wet,
    // so we don't need to reconstruct the core manually.
    bass_stereo = (bass_fx, bass_fx) : fx_reverb_stereo(bass_reverbAmt);
    mid_stereo  = (mid_fx, mid_fx)   : fx_reverb_stereo(mid_reverbAmt);
    side_stereo = (side_fx, side_fx * -1.0) : fx_reverb_stereo(side_reverbAmt);
};

fx_master = (process_chan, process_chan) : fx_reverb_stereo(reverbAmt)
with {
    process_chan = fx_chain_mono(distortionAmt, autotuneAmt, delayAmt, chorusAmt);
};

// --- MAIN PROCESSING CHAIN ---
process = 
    par(i, 2, *(gain)) 
    : par(i, 2, eq_stage)
    : stem_crossover
    : fx_master
    : par(i, 2, dist : excite) 
    : par(i, 2, mb_comp) 
    : haas_node 
    : ms_wid 
    : par(i, 2, limit_node);
