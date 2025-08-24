import React, { useEffect, useMemo, useRef, useState } from "react";

/* ===========================================================
   Wave Lab — Finishing Touches Build
   - Sticky mini-toolbar (Play/Mode/View/Speed/Sound/Mic)
   - Calm defaults (f long.=0.30 Hz sim; Sound → comoving + strobe assist)
   - Dynamic quality with FPS pacing + tab-idle throttle
   - Longitudinal clarity: auto-gain band alpha, particle spacing lock
   - Numeric steppers for A, f, λ + Reset View Only
   - Safe storage (quota-proof), sharable links, print view
   - WebM canvas recorder
   - Mic input with AudioWorklet (YIN-ish f0, RMS), freeze + scrub review
   - Interactive glossary popovers; mini-labs; error boundary
   =========================================================== */

/* ----------------------- Error Boundary ----------------------- */
class ErrorBoundary extends React.Component {
  constructor(props){ super(props); this.state={hasError:false, err:null}; }
  static getDerivedStateFromError(err){ return {hasError:true, err}; }
  componentDidCatch(err, info){ console.warn("WaveLab Error:", err, info); }
  render(){
    if(!this.state.hasError) return this.props.children;
    return (
      <div style={{padding:20, color:"#e5e7eb", background:"#0b1220", minHeight:"100vh"}}>
        <h2 style={{marginTop:0}}>Something went wrong 😅</h2>
        <p>Try <button onClick={()=>location.reload()} style={S.linkBtn}>reloading the page</button>.
           If it persists, click <button onClick={()=>{
             const blob = new Blob([JSON.stringify(this.state.err?.toString()||"unknown", null, 2)], {type:"application/json"});
             const url = URL.createObjectURL(blob);
             const a = document.createElement("a"); a.href=url; a.download="wavelab-error.json"; a.click();
           }} style={S.linkBtn}>download error</button> and share it.</p>
      </div>
    );
  }
}

/* ---------------------- Safe Storage API ---------------------- */
const safeStore = (() => {
  let ok = false;
  try {
    const t = "__wl_test__";
    window.localStorage.setItem(t, "1");
    window.localStorage.removeItem(t);
    ok = true;
  } catch { ok = false; }
  const mem = new Map();
  return {
    get(k, fallback=null){
      try {
        if (ok) {
          const v = window.localStorage.getItem(k);
          return v==null ? fallback : JSON.parse(v);
        } else {
          return mem.has(k) ? mem.get(k) : fallback;
        }
      } catch { return fallback; }
    },
    set(k, v){
      try {
        const s = JSON.stringify(v);
        if (s.length > 5000) return; // small cap per key
        if (ok) window.localStorage.setItem(k, s);
        else mem.set(k, v);
      } catch {
        // quota or parse — ignore
      }
    },
    del(k){
      try { ok ? window.localStorage.removeItem(k) : mem.delete(k); } catch {}
    }
  };
})();

/* -------------------- URL Share (lightweight) -------------------- */
function encodeState(obj){
  const j = JSON.stringify(obj);
  return btoa(unescape(encodeURIComponent(j)));
}
function decodeState(s){
  try { return JSON.parse(decodeURIComponent(escape(atob(s)))); } catch { return null; }
}

/* --------------------------- Helpers --------------------------- */
function clamp(x,lo,hi){ return Math.max(lo, Math.min(hi, x)); }
function lerp(a,b,t){ return a+(b-a)*t; }
function fmtSI(v, unit, d=2){
  if (!isFinite(v)) return "∞";
  const av = Math.abs(v);
  if (av >= 1) return v.toFixed(d)+" "+unit;
  if (av >= 1e-3) return (v*1e2).toFixed(d)+" cm";
  return (v*1e3).toFixed(d)+" mm";
}
function niceStep(v, step){ return Math.round(v/step)*step; }

/* -------------------- Pitch Worklet (inline) -------------------- */
const WORKLET_CODE = `
class WLPitchProcessor extends AudioWorkletProcessor {
  constructor(){
    super();
    this.buf = new Float32Array(8192);
    this.w = 0;
    this.lastSend = 0;
    this.sampleRate = sampleRate;
  }
  yin(buf, sr){
    // Simple YIN (very compact) for f0
    const n = buf.length;
    const maxLag = Math.min( Math.floor(sr/50), 2048 ); // down to 50 Hz
    const minLag = Math.max( Math.floor(sr/1000), 16 ); // up to 1 kHz
    const diff = new Float32Array(maxLag);
    for (let tau=minLag; tau<maxLag; tau++){
      let sum=0;
      for (let i=0;i<n-tau;i++){
        const d = buf[i]-buf[i+tau];
        sum += d*d;
      }
      diff[tau] = sum;
    }
    // cumulative mean normalized difference
    let cmnd = 1, bestTau=-1, thresh = 0.15;
    let running = 0;
    for (let tau=minLag; tau<maxLag; tau++){
      running += diff[tau];
      const d = diff[tau] * (tau / (running||1));
      if (d < thresh) { bestTau = tau; break; }
    }
    if (bestTau<0) {
      // pick global min
      let minv=Infinity, mint=minLag;
      for(let tau=minLag;tau<maxLag;tau++){ if(diff[tau]<minv){minv=diff[tau]; mint=tau;} }
      bestTau=mint;
    }
    return sr / bestTau;
  }
  process(inputs){
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch = input[0];
    const need = Math.min(ch.length, this.buf.length - this.w);
    this.buf.set(ch.subarray(0, need), this.w);
    this.w += need;

    // RMS + f0 every ~50ms
    const now = currentTime;
    if (this.w >= 2048 && (now - this.lastSend) > 0.05) {
      const segment = this.buf.subarray(0, 2048);
      // DC remove
      let mean=0; for (let i=0;i<segment.length;i++) mean += segment[i]; mean/=segment.length;
      let rms=0; for (let i=0;i<segment.length;i++){ const v = segment[i]-mean; rms += v*v; }
      rms = Math.sqrt(rms/segment.length);
      const f0 = this.yin(segment, this.sampleRate);
      this.port.postMessage({ f0, rms, t: now });
      // slide buffer by half
      this.buf.copyWithin(0, 1024, this.w);
      this.w -= 1024;
      this.lastSend = now;
    }
    return true;
  }
}
registerProcessor('wl-pitch', WLPitchProcessor);
`;

/* --------------------------- Component --------------------------- */
function WaveLabInner(){
  /* ======= Core State ======= */
  const [mode, setMode] = useState("transverse"); // 'transverse' | 'longitudinal' | 'standing'
  const [paused, setPaused] = useState(false);
  const [viewMode, setViewMode] = useState("lab"); // 'lab' | 'comoving' | 'strobe'
  const [speedFactor, setSpeedFactor] = useState(1);

  const [ampPx, setAmpPx] = useState(40);
  const [lambdaPx, setLambdaPx] = useState(360);
  const [freq, setFreq] = useState(0.6);
  const [phase, setPhase] = useState(0);

  // Calibration (m per 100 px)
  const [metersPer100px, setMetersPer100px] = useState(0.50);
  const mPerPx = metersPer100px / 100;

  // Medium
  const [lockSpeed, setLockSpeed] = useState(true);
  const [mediumType, setMediumType] = useState("air"); // 'air'|'string'|'shallow'|'custom'
  const [airTempC, setAirTempC] = useState(20);
  const [stringTensionN, setStringTensionN] = useState(50);
  const [stringMu, setStringMu] = useState(0.02);
  const [waterDepth, setWaterDepth] = useState(0.2);
  const [customSpeedSI, setCustomSpeedSI] = useState(2.4);

  const mediumSpeedSI = useMemo(() => {
    if (mediumType === "air") return 331 + 0.6 * airTempC;
    if (mediumType === "string") return Math.max(0.01, Math.sqrt(stringTensionN / Math.max(1e-6, stringMu)));
    if (mediumType === "shallow") return Math.sqrt(9.81 * Math.max(1e-3, waterDepth));
    return Math.max(0.01, customSpeedSI);
  }, [mediumType, airTempC, stringTensionN, stringMu, waterDepth, customSpeedSI]);

  // Visual toggles
  const [showGuides, setShowGuides] = useState(true);
  const [showWaveLine, setShowWaveLine] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const [showVelocityArrows, setShowVelocityArrows] = useState(true);
  const [clarityBoost, setClarityBoost] = useState(true);

  // Realism
  const [damping, setDamping] = useState(0.0);
  const [pulseMode, setPulseMode] = useState(false);
  const [dispersionAccent, setDispersionAccent] = useState(0.0);

  // Particles (auto with override)
  const [overrideParticles, setOverrideParticles] = useState(false);
  const [particleCountManual, setParticleCountManual] = useState(120);
  const [particleRadiusManual, setParticleRadiusManual] = useState(2.2);

  // Readouts highlight + popovers
  const [highlightKey, setHighlightKey] = useState(null);
  const [glossaryKey, setGlossaryKey] = useState(null);

  // Panels
  const [infoOpen, setInfoOpen] = useState(false);
  const [infoPage, setInfoPage] = useState("overview");
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [practiceOpen, setPracticeOpen] = useState(true);

  // Practice
  const [practiceRunning, setPracticeRunning] = useState(false);
  const [practiceDifficulty, setPracticeDifficulty] = useState("easy");
  const [session, setSession] = useState(null);

  // Mentor
  const [tip, setTip] = useState(null);
  const mentorSeen = useRef(new Set());
  const mentorLastTime = useRef(0);
  const mentorCooldownMs = 20000;

  // Canvas & performance
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const tRef = useRef(0);
  const lastTimeRef = useRef(performance.now());
  const rafRef = useRef(0);
  const [fps, setFps] = useState(60);
  const fpsAcc = useRef({last: performance.now(), frames:0});
  const [qualityScale, setQualityScale] = useState(1); // 0.6..1
  const [isHidden, setIsHidden] = useState(document.visibilityState !== "visible");
  useEffect(() => {
    const h = () => setIsHidden(document.visibilityState !== "visible");
    document.addEventListener("visibilitychange", h);
    return () => document.removeEventListener("visibilitychange", h);
  }, []);

  // Sticky toolbar sizing guard: ensure dock bottom controls visible by making dock scrollable internally if too short screen?
  // We keep left dock fixed height; toolbar ensures key controls always reachable.

  // Lock v enforcement
  const lastChanged = useRef("none");
  useEffect(() => {
    if (!lockSpeed) return;
    const v_px = mediumSpeedSI / Math.max(1e-9, mPerPx);
    if (lastChanged.current === "freq") {
      setLambdaPx(clamp(v_px / Math.max(1e-6, freq), 60, 1400));
    } else if (lastChanged.current === "lambda") {
      setFreq(clamp(v_px / Math.max(1e-6, lambdaPx), 0.05, 5));
    }
  }, [freq, lambdaPx, lockSpeed, mediumSpeedSI, mPerPx]);

  /* ======= Mic / Sound ======= */
  const [micSupported, setMicSupported] = useState(!!(navigator.mediaDevices && window.AudioContext));
  const [micOn, setMicOn] = useState(false);
  const [micFrozen, setMicFrozen] = useState(false);
  const [micF0, setMicF0] = useState(null);
  const [micRMS, setMicRMS] = useState(0);
  const [micLatencyMs, setMicLatencyMs] = useState(null);
  const [micFollow, setMicFollow] = useState(true); // map f0→freq, rms→amp
  const micCtxRef = useRef(null);
  const micNodeRef = useRef(null);
  const micStreamRef = useRef(null);
  const micLastT = useRef(null);

  // mic circular buffer for freeze + scrub
  const MBUF_SEC = 2.0;
  const [micBuf, setMicBuf] = useState([]); // [{t, f0, rms}]
  const [scrubPos, setScrubPos] = useState(1); // 0..1 position in buffer when frozen

  async function startMic(){
    if (!micSupported || micOn) return;
    try {
      const ac = new AudioContext({ latencyHint: "interactive" });
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const src = ac.createMediaStreamSource(stream);

      // Worklet module from blob
      const blob = new Blob([WORKLET_CODE], {type:"application/javascript"});
      const url = URL.createObjectURL(blob);
      await ac.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);

      const node = new AudioWorkletNode(ac, "wl-pitch");
      node.port.onmessage = (e) => {
        const { f0, rms, t } = e.data || {};
        const now = ac.currentTime;
        const dt = micLastT.current==null ? null : (now - micLastT.current);
        micLastT.current = now;
        if (dt!=null) setMicLatencyMs(Math.round(dt*1000));
        // simple smoothing
        setMicF0(prev => prev==null ? f0 : lerp(prev, f0, 0.3));
        setMicRMS(prev => prev==null ? rms : lerp(prev, rms, 0.25));
        if (!micFrozen) {
          setMicBuf(prev => {
            const cutoff = (performance.now()/1000) - MBUF_SEC;
            const filtered = prev.filter(p => p.wall > cutoff);
            return [...filtered, { f0, rms, wall: performance.now()/1000 }];
          });
        }
      };
      src.connect(node); node.connect(ac.destination); // or ac.createGain().connect(ac.destination) at low vol
      micCtxRef.current = ac; micNodeRef.current = node; micStreamRef.current = stream;
      setMicOn(true);
    } catch (e) {
      console.warn("Mic start failed", e);
      setMicSupported(false);
    }
  }
  function stopMic(){
    try {
      micNodeRef.current?.disconnect();
      micCtxRef.current?.close();
      micStreamRef.current?.getTracks()?.forEach(t=>t.stop());
    } catch {}
    micCtxRef.current = null; micNodeRef.current = null; micStreamRef.current = null;
    setMicOn(false);
  }

  // Follow mic to simulation (when enabled)
  useEffect(() => {
    if (!micOn || !micFollow) return;
    const f0 = micFrozen ? getScrubF0() : micF0;
    const rms = micFrozen ? getScrubRMS() : micRMS;
    if (f0 && isFinite(f0)) {
      // Show realistically: comoving for sound; strobe if very high
      if (mode === "longitudinal") {
        setViewMode("comoving");
        if (f0 > 600) setViewMode("strobe");
      }
      lastChanged.current="freq";
      setFreq(clamp(f0, 50, 1000)/ (viewMode==="lab" ? 2000 : 1000) ); 
      // ^ Scale down to visible sim rate; comoving/strobe make it intuitive.
    }
    if (rms && isFinite(rms)) {
      const px = clamp( 10 + rms*600, 6, 70 );
      setAmpPx(prev => lerp(prev, px, 0.25));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [micOn, micFrozen, micFollow, micF0, micRMS, mode, viewMode]);

  function getScrubSnapshot(){
    const buf = micBuf;
    if (!buf.length) return {f0:null, rms:0};
    const idx = clamp(Math.floor(scrubPos*(buf.length-1)), 0, buf.length-1);
    return buf[idx];
  }
  function getScrubF0(){ return getScrubSnapshot().f0 || null; }
  function getScrubRMS(){ return getScrubSnapshot().rms || 0; }

  /* ======= Derived Readouts ======= */
  const lambdaSI = lambdaPx * mPerPx;
  const vSI = mediumSpeedSI;
  const vPx = vSI / Math.max(1e-9, mPerPx);
  const T = freq > 0 ? 1 / freq : Infinity;
  const kSI = (2 * Math.PI) / Math.max(1e-9, lambdaSI);
  const omega = 2 * Math.PI * freq;
  const Pproxy = ampPx * ampPx * freq * freq;

  /* ======= Presets & Reset ======= */
  function applyPreset(name) {
    if (name === "rope") {
      setMode("transverse");
      setMediumType("string"); setStringTensionN(60); setStringMu(0.025);
      setMetersPer100px(0.50);
      setAmpPx(48);
      setFreq(0.6); lastChanged.current = "freq";
      const vpx = (Math.sqrt(60/0.025))/mPerPx; setLambdaPx(clamp(vpx/0.6, 120, 1200));
      setPhase(0);
      setViewMode("lab");
    } else if (name === "slinky") {
      setMode("longitudinal");
      setMediumType("custom"); setCustomSpeedSI(1.8);
      setMetersPer100px(0.40);
      setAmpPx(36);
      setFreq(0.30); lastChanged.current = "freq";  // calmer by default
      setLambdaPx(clamp((1.8/mPerPx)/0.30, 140, 1200));
      setPhase(0);
      setViewMode("lab");
    } else if (name === "sound") {
      // “Real-feel” sound: longitudinal + comoving + strobe assist
      setMode("longitudinal"); setMediumType("air"); setAirTempC(20);
      setMetersPer100px(0.30);
      setAmpPx(18);
      setFreq(0.35); lastChanged.current = "freq";
      const vpx = ((331+0.6*20)/mPerPx); setLambdaPx(clamp(vpx/0.35, 180, 1400));
      setPhase(0);
      setViewMode("comoving");
    } else if (name === "standing") {
      setMode("standing"); setMediumType("string"); setStringTensionN(45); setStringMu(0.02);
      setMetersPer100px(0.50); setAmpPx(40); setFreq(0.8); setPhase(0); lastChanged.current="freq";
      const vpx = (Math.sqrt(45/0.02)/mPerPx); setLambdaPx(clamp(vpx/0.8, 120, 1200));
      setViewMode("lab");
    }
  }
  function resetViewOnly(){
    setViewMode("lab");
    setSpeedFactor(1);
    setHighlightKey(null);
    setGlossaryKey(null);
  }
  function resetAll(){
    setMode("transverse"); setPaused(false); setViewMode("lab");
    setAmpPx(40); setLambdaPx(360); setFreq(0.6); setPhase(0);
    setMetersPer100px(0.50);
    setMediumType("air"); setAirTempC(20); setStringTensionN(50); setStringMu(0.02); setWaterDepth(0.2); setCustomSpeedSI(2.4);
    setLockSpeed(true);
    setShowGuides(true); setShowWaveLine(true); setShowLabels(true); setShowVelocityArrows(true); setClarityBoost(true);
    setDamping(0.0); setPulseMode(false); setDispersionAccent(0.0);
    setOverrideParticles(false); setParticleCountManual(120); setParticleRadiusManual(2.2);
    setHighlightKey(null); setGlossaryKey(null);
    setSettingsOpen(true); setPracticeOpen(true); setPracticeRunning(false); setPracticeDifficulty("easy"); setSession(null);
    setInfoOpen(false); setInfoPage("overview");
    mentorSeen.current.clear(); mentorLastTime.current=0; setTip(null);
    setSpeedFactor(1);
    if (micOn) stopMic();
  }

  /* ======= Mini-labs (simple checks) ======= */
  const [lab, setLab] = useState(null); // {id, steps:[{done:bool, text}], done}
  function runMiniLab(id){
    if (id==="halve-lambda"){
      setLab({ id, steps:[
        {text:"Lock v", done: lockSpeed},
        {text:"Increase frequency", done: false},
        {text:"λ decreased toward half", done: false},
      ]});
      setLockSpeed(true);
    } else if (id==="measure-k"){
      setLab({ id, steps:[
        {text:"Click λ badge to show ruler", done: highlightKey==="L"},
        {text:"Read λ and compute k=2π/λ", done: false},
      ]});
      setHighlightKey("L");
    }
  }
  useEffect(() => {
    if (!lab) return;
    const upd = {...lab, steps: lab.steps.map(s=>({...s}))};
    if (lab.id==="halve-lambda"){
      upd.steps[0].done = lockSpeed;
      // heuristic: freq increased recently
      upd.steps[1].done = freq > 0.8;
      upd.steps[2].done = lambdaPx < 0.75*360;
    } else if (lab.id==="measure-k"){
      upd.steps[0].done = highlightKey==="L";
      upd.steps[1].done = true;
    }
    upd.done = upd.steps.every(s=>s.done);
    setLab(upd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lab?.id, lockSpeed, freq, lambdaPx, highlightKey]);

  /* ======= Mentor cadence ======= */
  const [tipVisible, setTipVisible] = useState(null);
  function showTipOnce(id, title, body){
    const now = performance.now();
    if (mentorSeen.current.has(id)) return;
    if (now - mentorLastTime.current < mentorCooldownMs) return;
    mentorSeen.current.add(id); mentorLastTime.current = now;
    setTipVisible({title, body});
    setTimeout(()=>setTipVisible(null), 6000);
  }
  const prevRef = useRef({ mode, ampPx, freq, lambdaPx, lockSpeed });
  useEffect(() => {
    const prev = prevRef.current;
    if (mode !== prev.mode) {
      if (mode === "longitudinal") showTipOnce("t-long","Longitudinal clarity","Use comoving view for sound; darker bands are compressions.");
      if (mode === "transverse") showTipOnce("t-trans","Transverse motion","Particles move ⟂ to travel. Lock v then raise f and see λ shrink.");
      if (mode === "standing") showTipOnce("t-stand","Standing waves","Nodes stay still; antinodes swing big. Node spacing ~ λ/2.");
    }
    if (Math.abs(ampPx - prev.ampPx) / Math.max(1, prev.ampPx) > 0.25)
      showTipOnce("t-A","Energy vs A","Transported power tends to grow like A²f² (illustrative).");
    if (lockSpeed && (Math.abs(freq - prev.freq) > 0.05 || Math.abs(lambdaPx - prev.lambdaPx) > 20))
      showTipOnce("t-vfl","Constant speed medium","With Lock v, speed is set by medium; f and λ trade via v=fλ.");
    prevRef.current = { mode, ampPx, freq, lambdaPx, lockSpeed };
  }, [mode, ampPx, freq, lambdaPx, lockSpeed]);

  /* ======= Canvas sizing (fixed CSS size; buffer DPR) ======= */
  useEffect(() => {
    const wrap = wrapRef.current, canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const setBuffer = () => {
      const DPR = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.floor(wrap.clientWidth * DPR));
      const h = Math.max(1, Math.floor(wrap.clientHeight * DPR));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    };
    setBuffer();
    let r = 0;
    const onResize = () => { if (r) cancelAnimationFrame(r); r = requestAnimationFrame(setBuffer); };
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("resize", onResize); if (r) cancelAnimationFrame(r); };
  }, []);

  /* ======= Prebaked gradient for longitudinal bands ======= */
  const bandTexRef = useRef(null);
  useEffect(() => {
    // small gradient texture (1x64) to stretch
    const c = document.createElement("canvas");
    c.width = 1; c.height = 64;
    const g = c.getContext("2d");
    const grad = g.createLinearGradient(0,0,0,64);
    grad.addColorStop(0, "#0c4a6e");   // deep
    grad.addColorStop(0.5, "#38bdf8"); // mid
    grad.addColorStop(1, "#0ea5e9");   // light
    g.fillStyle = grad; g.fillRect(0,0,1,64);
    bandTexRef.current = c;
  }, []);

  /* ======= Animation Loop ======= */
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext("2d");

    const frame = (now) => {
      const dtRaw = Math.min(0.05, (now - lastTimeRef.current) / 1000);
      lastTimeRef.current = now;

      const dt = dtRaw * (speedFactor || 1) * (isHidden ? 0.2 : 1);
      if (!paused) tRef.current += dt;

      // draw
      draw(ctx, {
        mode, viewMode,
        A: ampPx,
        Lpx: lambdaPx,
        f: freq,
        phi: phase,
        t: tRef.current,
        v_px: vPx,
        showGuides, showWaveLine, showLabels, showVelocityArrows, clarityBoost,
        damping, pulseMode, dispersionAccent,
        overrideParticles, particleCountManual, particleRadiusManual,
        highlightKey,
        bandTex: bandTexRef.current,
        quality: qualityScale,
      });

      // FPS & dynamic quality
      const a = fpsAcc.current;
      a.frames++;
      const since = now - a.last;
      if (since >= 500) {
        const f = Math.round((a.frames*1000)/since);
        setFps(f);
        a.frames = 0; a.last = now;
        // adjust quality scale smoothly
        if (f < 45) setQualityScale(q => Math.max(0.6, q - 0.05));
        else if (f > 57) setQualityScale(q => Math.min(1.0, q + 0.03));
      }

      rafRef.current = requestAnimationFrame(frame);
    };

    rafRef.current = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(rafRef.current);
  }, [
    paused, speedFactor, isHidden,
    mode, viewMode, ampPx, lambdaPx, freq, phase, vPx,
    showGuides, showWaveLine, showLabels, showVelocityArrows, clarityBoost,
    damping, pulseMode, dispersionAccent,
    overrideParticles, particleCountManual, particleRadiusManual, highlightKey, qualityScale
  ]);

  /* ======= Shareable Links ======= */
  useEffect(() => {
    // Load state from URL once (if present)
    const url = new URL(window.location.href);
    const s = url.searchParams.get("s");
    if (s) {
      const st = decodeState(s);
      if (st) {
        try {
          setMode(st.m || "transverse");
          setViewMode(st.vm || "lab");
          setAmpPx(st.A ?? 40);
          setLambdaPx(st.Lpx ?? 360);
          setFreq(st.f ?? 0.6);
          setPhase(st.phi ?? 0);
          setMetersPer100px(st.m100 ?? 0.5);
          setMediumType(st.mt || "air");
          setAirTempC(st.tc ?? 20);
          setStringTensionN(st.T ?? 50);
          setStringMu(st.mu ?? 0.02);
          setWaterDepth(st.h ?? 0.2);
          setCustomSpeedSI(st.cv ?? 2.4);
          setLockSpeed(st.lv ?? true);
        } catch {}
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function copyShareLink(){
    const st = {
      m: mode, vm: viewMode, A: ampPx, Lpx: lambdaPx, f: freq, phi: phase,
      m100: metersPer100px, mt: mediumType, tc: airTempC, T: stringTensionN, mu: stringMu, h: waterDepth, cv: customSpeedSI, lv: lockSpeed
    };
    const enc = encodeState(st);
    const url = new URL(window.location.href);
    url.searchParams.set("s", enc);
    navigator.clipboard?.writeText(url.toString());
  }

  /* ======= WebM Recorder ======= */
  const [recState, setRecState] = useState("idle"); // idle | rec | saving
  const recRef = useRef({ rec:null, chunks:[] });
  function toggleRecord(){
    if (recState==="idle"){
      const canvas = canvasRef.current;
      const stream = canvas.captureStream(60);
      const rec = new MediaRecorder(stream, { mimeType: "video/webm; codecs=vp9" });
      recRef.current.chunks = [];
      rec.ondataavailable = (e)=>{ if (e.data.size) recRef.current.chunks.push(e.data); };
      rec.onstop = ()=>{
        setRecState("saving");
        const blob = new Blob(recRef.current.chunks, {type:"video/webm"});
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a"); a.href = url; a.download = "wavelab.webm"; a.click();
        URL.revokeObjectURL(url);
        setRecState("idle");
      };
      rec.start();
      recRef.current.rec = rec;
      setRecState("rec");
    } else if (recState==="rec"){
      recRef.current.rec?.stop();
    }
  }

  /* ======= UI ======= */
  return (
    <div style={S.page}>
      <div style={S.container}>
        {/* Header */}
        <header style={S.header}>
          <div>
            <h1 style={S.title}>Wave Lab</h1>
            <p style={S.subtitle}>Crystal-clear waves • SI units • mic input • share & record • practice & lessons</p>
          </div>
          <div style={{display:"flex", gap:8, alignItems:"center", flexWrap:"wrap"}}>
            <button onClick={()=>setPaused(p=>!p)} style={S.primaryBtn} aria-label={paused?"Play simulation":"Pause simulation"}>{paused? "► Play":"⏸ Pause"}</button>
            <button onClick={resetViewOnly} style={S.ghostBtn}>Reset view</button>
            <button onClick={resetAll} style={S.ghostBtn}>Reset all</button>
            <div title="Frames per second" style={S.fpsPill}>{Math.round(fps)} fps · q{qualityScale.toFixed(2)}</div>
          </div>
        </header>

        {/* Columns */}
        <div style={S.columns}>
          {/* Left Dock */}
          <aside style={S.dock} aria-label="Basic controls">
            <Card title="Mode & Presets">
              <Row>
                <SegButton active={mode==="transverse"} onClick={()=>setMode("transverse")}>⤴︎ Transverse</SegButton>
                <SegButton active={mode==="longitudinal"} onClick={()=>setMode("longitudinal")}>⇢ Longitudinal</SegButton>
                <SegButton active={mode==="standing"} onClick={()=>setMode("standing")}>∿ Standing</SegButton>
              </Row>
              <Row wrap>
                <SegButton small active={false} onClick={()=>applyPreset("rope")}>Rope</SegButton>
                <SegButton small active={false} onClick={()=>applyPreset("slinky")}>Slinky</SegButton>
                <SegButton small active={false} onClick={()=>applyPreset("sound")}>Sound</SegButton>
                <SegButton small active={false} onClick={()=>applyPreset("standing")}>Standing</SegButton>
              </Row>
            </Card>

            <Card title="Amplitude (A)">
              <Line label="Amplitude" value={`${Math.round(ampPx)} px (${fmtSI(ampPx*mPerPx,"m",2)})`} />
              <Row>
                <button aria-label="Decrease amplitude" onClick={()=>setAmpPx(v=>clamp(niceStep(v-2,1),0,100))} style={S.stepBtn}>−</button>
                <input aria-label="Amplitude slider" type="range" min={0} max={100} step={1} value={ampPx} onChange={(e)=>setAmpPx(parseFloat(e.target.value))} style={S.slider}/>
                <button aria-label="Increase amplitude" onClick={()=>setAmpPx(v=>clamp(niceStep(v+2,1),0,100))} style={S.stepBtn}>+</button>
              </Row>
              <Hint>Bigger A → taller crests or stronger compressions. Often energy ∝ A²f².</Hint>
            </Card>

            <Card title="Frequency (f)">
              <Line label="Frequency" value={`${freq.toFixed(2)} Hz`} />
              <Row>
                <button aria-label="Decrease frequency" onClick={()=>{ lastChanged.current="freq"; setFreq(v=>clamp(niceStep(v-0.02,0.01),0.05,5)); }} style={S.stepBtn}>−</button>
                <input aria-label="Frequency slider" type="range" min={0.05} max={5} step={0.01} value={freq}
                  onChange={(e)=>{ lastChanged.current="freq"; setFreq(parseFloat(e.target.value)); }} style={S.slider}/>
                <button aria-label="Increase frequency" onClick={()=>{ lastChanged.current="freq"; setFreq(v=>clamp(niceStep(v+0.02,0.01),0.05,5)); }} style={S.stepBtn}>+</button>
              </Row>
              <Row>
                <label><input type="checkbox" checked={lockSpeed} onChange={(e)=>setLockSpeed(e.target.checked)} /> Lock v</label>
                <span style={S.monoSmall}>v ≈ {fmtSI(vSI,"m/s",2)} ({Math.round(vPx)} px/s)</span>
              </Row>
            </Card>

            <Card title="Wavelength (λ) & Phase">
              <Line label="Wavelength" value={`${fmtSI(lambdaSI,"m",3)} (${Math.round(lambdaPx)} px)`} />
              <Row>
                <button aria-label="Decrease wavelength" onClick={()=>{ lastChanged.current="lambda"; setLambdaPx(v=>clamp(niceStep(v-6,1),60,1400)); }} style={S.stepBtn}>−</button>
                <input aria-label="Wavelength slider" type="range" min={60} max={1400} step={1} value={lambdaPx}
                  onChange={(e)=>{ lastChanged.current="lambda"; setLambdaPx(parseFloat(e.target.value)); }} style={S.slider}/>
                <button aria-label="Increase wavelength" onClick={()=>{ lastChanged.current="lambda"; setLambdaPx(v=>clamp(niceStep(v+6,1),60,1400)); }} style={S.stepBtn}>+</button>
              </Row>
              <Line label="Phase (φ)" value={`${phase.toFixed(2)} rad`} />
              <input aria-label="Phase slider" type="range" min={0} max={Math.PI*2} step={0.01} value={phase}
                onChange={(e)=>setPhase(parseFloat(e.target.value))} style={S.slider}/>
            </Card>

            <Card title="Calibration & Medium">
              <Line label="Meters per 100 px" value={`${metersPer100px.toFixed(3)} m`} />
              <input aria-label="Calibration slider" type="range" min={0.05} max={2} step={0.01} value={metersPer100px}
                onChange={(e)=>setMetersPer100px(parseFloat(e.target.value))} style={S.slider}/>
              <Row wrap>
                <SegButton small active={mediumType==="air"} onClick={()=>setMediumType("air")}>Air</SegButton>
                <SegButton small active={mediumType==="string"} onClick={()=>setMediumType("string")}>String</SegButton>
                <SegButton small active={mediumType==="shallow"} onClick={()=>setMediumType("shallow")}>Shallow water</SegButton>
                <SegButton small active={mediumType==="custom"} onClick={()=>setMediumType("custom")}>Custom</SegButton>
              </Row>
              {mediumType==="air" && (<>
                <Line label="Air temperature" value={`${airTempC.toFixed(1)} °C`} />
                <input aria-label="Air temperature" type="range" min={-10} max={40} step={0.5} value={airTempC} onChange={(e)=>setAirTempC(parseFloat(e.target.value))} style={S.slider}/>
                <Hint>c ≈ 331 + 0.6·T (m/s).</Hint>
              </>)}
              {mediumType==="string" && (<>
                <Line label="Tension (T)" value={`${stringTensionN.toFixed(1)} N`} />
                <input aria-label="String tension" type="range" min={5} max={120} step={1} value={stringTensionN} onChange={(e)=>setStringTensionN(parseFloat(e.target.value))} style={S.slider}/>
                <Line label="Linear density (μ)" value={`${stringMu.toFixed(3)} kg/m`} />
                <input aria-label="Linear density" type="range" min={0.005} max={0.08} step={0.001} value={stringMu} onChange={(e)=>setStringMu(parseFloat(e.target.value))} style={S.slider}/>
                <Hint>String: v = √(T/μ).</Hint>
              </>)}
              {mediumType==="shallow" && (<>
                <Line label="Water depth (h)" value={`${waterDepth.toFixed(3)} m`} />
                <input aria-label="Water depth" type="range" min={0.02} max={1.0} step={0.01} value={waterDepth} onChange={(e)=>setWaterDepth(parseFloat(e.target.value))} style={S.slider}/>
                <Hint>Shallow-water: v ≈ √(gh).</Hint>
              </>)}
              {mediumType==="custom" && (<>
                <Line label="Custom speed (v)" value={`${customSpeedSI.toFixed(2)} m/s`} />
                <input aria-label="Custom speed" type="range" min={0.2} max={20} step={0.1} value={customSpeedSI} onChange={(e)=>setCustomSpeedSI(parseFloat(e.target.value))} style={S.slider}/>
              </>)}
            </Card>

            <Row style={{marginTop:"auto", justifyContent:"space-between"}}>
              <button onClick={()=>setInfoOpen(true)} style={S.ghostBtnSmall}>Learn</button>
              <button onClick={()=>setSettingsOpen(o=>!o)} style={S.ghostBtnSmall}>{settingsOpen?"Hide":"Show"} Settings</button>
            </Row>
          </aside>

          {/* Center: Readouts + Canvas + Toolbar */}
          <main style={S.center}>
            <Readouts
              Apx={ampPx} A={ampPx*mPerPx}
              Lpx={lambdaPx} L={lambdaSI}
              f={freq} T={T} k={kSI} w={omega}
              v={vSI} vpx={vPx}
              P={Pproxy}
              onClickBadge={(key)=>{ setHighlightKey(key==="λ"?"L":key); setGlossaryKey(key); }}
              glossaryKey={glossaryKey}
              onCloseGlossary={()=>setGlossaryKey(null)}
            />

            <div ref={wrapRef} style={S.canvasWrap} aria-label="Wave canvas">
              <canvas ref={canvasRef} style={{width:"100%", height:"100%"}} />
              {tipVisible && (
                <div style={S.tipBubble}>
                  <div style={{fontWeight:700, marginBottom:4}}>{tipVisible.title}</div>
                  <div style={{fontSize:13, color:"#cbd5e1"}}>{tipVisible.body}</div>
                  <div style={{marginTop:6, fontSize:12, color:"#94a3b8"}}>Tips appear rarely and won’t repeat this session.</div>
                </div>
              )}
              {/* Mini-lab checklist */}
              {lab && (
                <div style={S.labBubble}>
                  <div style={{fontWeight:700, marginBottom:6}}>Mini-Lab</div>
                  <ol style={{margin:0, paddingLeft:18}}>
                    {lab.steps.map((s,i)=>(<li key={i} style={{opacity:s.done?0.8:1}}>{s.done?"✅ ":""}{s.text}</li>))}
                  </ol>
                  {lab.done && <div style={{marginTop:6, color:"#34d399"}}>Completed!</div>}
                </div>
              )}
            </div>

            {/* Sticky mini-toolbar */}
            <div style={S.toolbar}>
              <button onClick={()=>setPaused(p=>!p)} style={S.toolbarBtn} aria-label={paused?"Play":"Pause"}>{paused?"►":"⏸"}</button>
              <select aria-label="View mode" value={viewMode} onChange={(e)=>setViewMode(e.target.value)} style={S.toolbarSelect}>
                <option value="lab">View: Lab</option>
                <option value="comoving">View: Comoving</option>
                <option value="strobe">View: Strobe</option>
              </select>
              <div style={{display:"flex", alignItems:"center", gap:6}}>
                <span style={S.toolbarLabel}>Speed</span>
                <input aria-label="Playback speed" type="range" min={0.1} max={3} step={0.1} value={speedFactor} onChange={(e)=>setSpeedFactor(parseFloat(e.target.value))} />
                <span style={S.monoSmall}>{speedFactor.toFixed(1)}×</span>
              </div>
              <button onClick={()=>applyPreset("sound")} style={S.toolbarBtn} title="Sound preset">🔊</button>
              <button onClick={()=>runMiniLab("halve-lambda")} style={S.toolbarBtn} title="Mini-lab: halve λ">🎯</button>
              <button onClick={copyShareLink} style={S.toolbarBtn} title="Copy share link">🔗</button>
              <button onClick={toggleRecord} style={S.toolbarBtn} title="Record WebM">{recState==="rec"?"⏹":"⏺"}</button>
              {/* Mic cluster */}
              <div style={{display:"flex", alignItems:"center", gap:6}}>
                {!micOn ? (
                  <button onClick={startMic} style={S.toolbarBtn} disabled={!micSupported} title="Use Microphone">🎤</button>
                ) : (
                  <>
                    <button onClick={stopMic} style={S.toolbarBtn} title="Stop mic">🛑</button>
                    <label style={S.toolbarSmall}><input type="checkbox" checked={micFollow} onChange={(e)=>setMicFollow(e.target.checked)} /> follow</label>
                    <button onClick={()=>setMicFrozen(f=>!f)} style={S.toolbarBtn} title={micFrozen?"Unfreeze":"Freeze & scrub"}>{micFrozen?"🧊":"⏸"}</button>
                    {micFrozen && (
                      <>
                        <input aria-label="Scrub mic buffer" type="range" min={0} max={1} step={0.01} value={scrubPos} onChange={(e)=>setScrubPos(parseFloat(e.target.value))} />
                        <span style={S.monoSmall}>pos {scrubPos.toFixed(2)}</span>
                      </>
                    )}
                    <span style={S.monoSmall}>{micF0? `${Math.round(micF0)} Hz` : "-- Hz"} · {(micRMS||0).toFixed(3)} rms · {micLatencyMs??"--"} ms</span>
                  </>
                )}
              </div>
            </div>

            <Tips mode={mode}/>
          </main>

          {/* Right: Settings + Practice */}
          <aside style={S.rightCol}>
            {settingsOpen && (
              <div style={S.settingsBox}>
                <div style={S.settingsHeader}>Settings</div>
                <div style={S.settingsScroll}>
                  <SubCard title="Visibility">
                    <Row wrap>
                      <label><input type="checkbox" checked={showGuides} onChange={(e)=>setShowGuides(e.target.checked)}/> Guides</label>
                      <label><input type="checkbox" checked={showWaveLine} onChange={(e)=>setShowWaveLine(e.target.checked)}/> Wave line</label>
                      <label><input type="checkbox" checked={showLabels} onChange={(e)=>setShowLabels(e.target.checked)}/> Labels</label>
                      <label><input type="checkbox" checked={showVelocityArrows} onChange={(e)=>setShowVelocityArrows(e.target.checked)}/> Velocity arrows</label>
                      <label><input type="checkbox" checked={clarityBoost} onChange={(e)=>setClarityBoost(e.target.checked)}/> Clarity boost</label>
                    </Row>
                    <Row>
                      <Line label="Damping (γ)" value={`${damping.toFixed(2)} s⁻¹`} />
                      <input aria-label="Damping slider" type="range" min={0} max={0.5} step={0.01} value={damping} onChange={(e)=>setDamping(parseFloat(e.target.value))} style={S.slider}/>
                    </Row>
                    <Row>
                      <label><input type="checkbox" checked={pulseMode} onChange={(e)=>setPulseMode(e.target.checked)}/> Pulse (Gaussian packet)</label>
                    </Row>
                    <Row>
                      <Line label="Dispersion accent" value={`${dispersionAccent.toFixed(2)}`} />
                      <input aria-label="Dispersion slider" type="range" min={0} max={0.5} step={0.01} value={dispersionAccent} onChange={(e)=>setDispersionAccent(parseFloat(e.target.value))} style={S.slider}/>
                    </Row>
                  </SubCard>

                  <SubCard title="Particles (auto clarity)">
                    <Row>
                      <label><input type="checkbox" checked={overrideParticles} onChange={(e)=>setOverrideParticles(e.target.checked)}/> Manual override</label>
                    </Row>
                    <Line label="Count" value={`${Math.round(particleCountManual)}`} />
                    <input aria-label="Particle count" type="range" min={30} max={220} step={1} value={particleCountManual} disabled={!overrideParticles}
                      onChange={(e)=>setParticleCountManual(parseFloat(e.target.value))} style={S.slider}/>
                    <Line label="Size" value={`${particleRadiusManual.toFixed(1)} px`} />
                    <input aria-label="Particle size" type="range" min={1.2} max={4} step={0.1} value={particleRadiusManual} disabled={!overrideParticles}
                      onChange={(e)=>setParticleRadiusManual(parseFloat(e.target.value))} style={S.slider}/>
                  </SubCard>
                </div>
              </div>
            )}

            {/* Practice */}
            {practiceOpen && (
              <PracticePanel
                running={practiceRunning}
                session={session}
                difficulty={practiceDifficulty}
                onSetDifficulty={setPracticeDifficulty}
                onStart={()=>{
                  const probs = [];
                  for (let i=0;i<10;i++) probs.push(genProblem("mixed", practiceDifficulty, { mPerPx, vSI, lambdaSI }));
                  setSession({ problems: probs, idx: 0, correct: 0, wrong: 0, results: [] });
                  setPracticeRunning(true);
                }}
                onAnswered={(ok)=>{
                  setSession(s => {
                    if (!s) return s;
                    const next = s.idx + 1;
                    const updated = {
                      ...s,
                      idx: next,
                      correct: s.correct + (ok?1:0),
                      wrong: s.wrong + (ok?0:1),
                      results: [...s.results, ok]
                    };
                    return updated;
                  });
                }}
                onRestartSimilar={()=>{
                  if (!session) return;
                  const missIdx = session.results.map((ok,i)=>!ok?i:null).filter(x=>x!==null);
                  const skills = missIdx.length ? missIdx.map(i=>session.problems[i].skill) : ["mixed"];
                  const probs = [];
                  for (let i=0;i<10;i++) probs.push(genProblem(skills[i%skills.length], practiceDifficulty, {mPerPx, vSI, lambdaSI}));
                  setSession({ problems: probs, idx: 0, correct: 0, wrong: 0, results: [] });
                  setPracticeRunning(true);
                }}
              />
            )}
            <div style={{display:"flex", gap:8, marginTop:8}}>
              <button onClick={()=>setPracticeOpen(p=>!p)} style={S.ghostBtnSmall}>{practiceOpen?"Hide":"Show"} Practice</button>
              <button onClick={()=>{ setInfoOpen(true); setInfoPage("overview"); }} style={S.ghostBtnSmall}>Open Learn</button>
            </div>
          </aside>
        </div>
      </div>

      {/* Learn Drawer */}
      {infoOpen && <InfoDrawer
        page={infoPage}
        onClose={()=>setInfoOpen(false)}
        onNavigate={(p)=>setInfoPage(p)}
        tryIt={(action)=>{
          if (action==="measure-lambda"){ setHighlightKey("L"); }
          if (action==="standing-nodes"){ setMode("standing"); }
          if (action==="slowmo"){ setSpeedFactor(0.3); }
          if (action==="mini-halve"){ runMiniLab("halve-lambda"); }
          if (action==="mini-k"){ runMiniLab("measure-k"); }
        }}
        detailLevelKey="detailLevel"
      />}
    </div>
  );
}

/* ------------------------------ Drawing ------------------------------ */
function draw(ctx, o){
  const {
    mode, viewMode, A, Lpx, f, phi, t, v_px,
    showGuides, showWaveLine, showLabels, showVelocityArrows, clarityBoost,
    damping, pulseMode, dispersionAccent,
    overrideParticles, particleCountManual, particleRadiusManual,
    highlightKey, bandTex, quality
  } = o;

  const c = ctx.canvas, DPR = window.devicePixelRatio || 1;
  const W = c.width / DPR, H = c.height / DPR;
  ctx.save(); ctx.scale(DPR, DPR); ctx.clearRect(0,0,W,H);

  const pad = 28, left=pad, right=W - pad, width = Math.max(1, right-left);
  const midY = H * 0.54;

  const K = (2*Math.PI)/Math.max(1e-6, Lpx);
  let OMG = 2*Math.PI*f;
  if (dispersionAccent>0) OMG += dispersionAccent*(K*K);

  const Aeff = A * Math.exp(-damping * t);

  const pulse = (x)=> {
    if (!pulseMode) return 1;
    const sigma = width*0.18;
    let x0 = left + width*0.35 + v_px * t;
    if (viewMode==="comoving") x0 = left + width*0.5; // hold center
    const dx = x - x0;
    return Math.exp(-(dx*dx)/(2*sigma*sigma));
  };

  if (showGuides) {
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(148,163,184,0.35)";
    ctx.beginPath(); ctx.moveTo(left, midY); ctx.lineTo(right, midY); ctx.stroke();
    ctx.beginPath(); const step = width/12;
    for (let x=left; x<=right+0.5; x+=step){ ctx.moveTo(x, midY-6); ctx.lineTo(x, midY+6); }
    ctx.stroke();
  }

  // λ ruler
  if (highlightKey === "L") {
    const x1 = left + width*0.18, x2 = x1 + Lpx;
    drawLambdaRuler(ctx, x1, x2, midY - (Aeff+60));
  }

  // Auto particles
  const auto = computeAutoParticles(mode, Aeff, Lpx, width, clarityBoost);
  let PCOUNT = overrideParticles ? clamp(Math.round(particleCountManual), 30, 220) : auto.count;
  let PRADIUS = overrideParticles ? clamp(particleRadiusManual, 1.2, 4) : auto.radius;

  // Particle spacing lock: ensure spacing ≥ 2*R + 2px
  const minGap = 2;
  const dxTry = width / Math.max(1, PCOUNT);
  const need = 2*PRADIUS + minGap;
  if (dxTry < need) {
    // First reduce count
    const newCount = Math.floor(width / need);
    if (newCount >= 24) PCOUNT = newCount; else PRADIUS = Math.max(1.2, (dxTry - minGap)/2);
  }

  // View transforms
  let phaseShift = 0;
  let strobeHold = false;
  if (viewMode==="comoving") {
    // shift phase so pattern appears stationary
    // Replace (kx - ωt) with (k(x - vt)) ≈ stationary
    // Equivalent: add ωt to phase
    phaseShift = OMG*t;
  } else if (viewMode==="strobe") {
    // Freeze near “frame-matching”
    const cycle = (OMG*t)%(2*Math.PI);
    strobeHold = (cycle < 0.15 || cycle > 2*Math.PI-0.15);
  }

  const yTravel = (x)=> Aeff * pulse(x) * Math.sin(K*x - OMG*t + phi + phaseShift);
  const yStanding = (x)=> 2*Aeff*Math.sin(K*x)*Math.cos(OMG*t + phi);

  // Draw
  if (mode === "transverse" || mode === "standing") {
    const fn = mode==="standing" ? yStanding : yTravel;

    if (showWaveLine) {
      ctx.lineWidth = 2;
      const grad = ctx.createLinearGradient(left, midY - 80, right, midY + 80);
      grad.addColorStop(0, "#22c55e"); grad.addColorStop(1, "#38bdf8");
      ctx.strokeStyle = grad;
      ctx.beginPath();
      const N = Math.floor(700*quality);
      for (let i=0;i<=N;i++){
        const x = left + (i/N)*width;
        const y = midY - fn(x);
        if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
      }
      ctx.stroke();
    }

    // deterministic jitter (stable per index)
    ctx.fillStyle="#e2e8f0";
    const dx = width / PCOUNT;
    for (let i=0;i<=PCOUNT;i++){
      const x = left + i*dx;
      const seed = (i*1664525 + 1013904223)>>>0;
      const j = ((seed & 0xff)/255 - 0.5)*0.4; // ±0.2px
      const y = midY - fn(x);
      dot(ctx, x + j, y, PRADIUS);
    }

    if (showLabels) {
      label(ctx, right - width*0.25, midY - (Aeff+32), "Crest");
      label(ctx, right - width*0.25, midY + (Aeff+42), "Trough");
    }
  }

  if (mode === "longitudinal") {
    // Bands (prebaked texture stretched per column)
    const bands = Math.floor(260*quality);
    const base = clarityBoost ? 0.14 : 0.12;
    const spanBase = clarityBoost ? 0.58 : 0.46;
    const motion = clamp(Aeff*OMG/300, 0, 0.35); // auto-gain by perceived motion
    const span = spanBase + motion;

    for (let i=0;i<=bands;i++){
      const x = left + (i/bands)*width;
      const d = Math.cos(K*x - OMG*t + phi + phaseShift);
      const alpha = base + span*(0.5+0.5*d);
      if (bandTex){
        ctx.globalAlpha = alpha;
        ctx.drawImage(bandTex, 0,0,1,64, x, midY-30, Math.max(1,width/bands), 60);
      } else {
        ctx.fillStyle = `rgba(56,189,248,${alpha})`;
        ctx.fillRect(x, midY - 30, Math.max(1, width/bands), 60);
      }
    }
    ctx.globalAlpha = 1;

    // particles oscillating along x
    const N = PCOUNT;
    const step = width / N;
    ctx.fillStyle="#e2e8f0";
    for (let i=0;i<=N;i++){
      const x0 = left + i*step;
      const dxp = Aeff * Math.sin(K*x0 - OMG*t + phi + phaseShift);
      const seed = (i*22695477 + 1)>>>0;
      const jy = ((seed & 0xff)/255 - 0.5)*0.3;
      dot(ctx, x0 + dxp, midY + jy, PRADIUS);
    }

    if (showVelocityArrows) {
      const every = Math.max(14, Math.floor(width/40));
      for (let i=0;i<=width;i+=every){
        const x0 = left+i;
        const vel = Aeff*OMG*Math.cos(K*x0 - OMG*t + phi + phaseShift);
        const len = clamp(Math.abs(vel)*0.015*(clarityBoost?1.2:1), 4, 16);
        drawHArrow(ctx, x0, midY-40, (vel>=0?len:-len), 6, "rgba(226,232,240,0.85)");
      }
    }

    if (showWaveLine) { ctx.strokeStyle="#22c55e"; ctx.lineWidth=2; ctx.beginPath(); ctx.moveTo(left, midY+34); ctx.lineTo(right, midY+34); ctx.stroke(); }
    if (showLabels) { label(ctx, left+width*0.34, midY - 44, "Compression"); label(ctx, left+width*0.56, midY - 44, "Rarefaction"); }
  }

  // Strobe freeze hint (subtle)
  if (viewMode==="strobe") {
    ctx.fillStyle="rgba(15,23,42,0.65)";
    ctx.fillRect(left, midY-70, 140, 18);
    ctx.fillStyle="#cbd5e1";
    ctx.font="12px ui-sans-serif, system-ui, -apple-system";
    ctx.fillText("Strobe view", left+6, midY-56);
  }

  ctx.restore();
}

function computeAutoParticles(mode, A, L, width, clarity){
  const spacing = Math.max(L/18, width/160);
  let count = clamp(Math.round(width/spacing), 28, 200);
  if (mode==="longitudinal") count = clamp(Math.round(count*(clarity?0.66:0.75)), 24, 170);
  if (mode==="standing") count = clamp(Math.round(count*0.9), 24, 190);
  let radius = clamp(1.6 + 0.0012*L, 1.8, 3.6);
  if (mode==="longitudinal") radius = Math.max(radius, clarity?2.6:2.2);
  if (A>60) radius = Math.min(radius, 2.8);
  return { count, radius };
}

/* primitives */
function dot(ctx,x,y,r){ ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI*2); ctx.fill(); }
function label(ctx,x,y,text){ ctx.save(); ctx.font="12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto"; ctx.textAlign="center"; ctx.fillStyle="rgba(226,232,240,0.96)"; ctx.fillText(text, x, y); ctx.restore(); }
function drawHArrow(ctx,x,y,dx,size,color){ ctx.save(); ctx.strokeStyle=color; ctx.fillStyle=color; ctx.lineWidth=1.2; ctx.beginPath(); ctx.moveTo(x,y); ctx.lineTo(x+dx,y); ctx.stroke(); const s=size||6; const dir=dx>=0?1:-1; ctx.beginPath(); ctx.moveTo(x+dx,y); ctx.lineTo(x+dx-dir*s,y-s*0.55); ctx.lineTo(x+dx-dir*s,y+s*0.55); ctx.closePath(); ctx.fill(); ctx.restore(); }
function drawLambdaRuler(ctx, x1, x2, y) {
  ctx.save();
  ctx.strokeStyle = "rgba(147,197,253,0.95)";
  ctx.fillStyle = "rgba(147,197,253,0.95)";
  ctx.lineWidth = 1.4;

  ctx.beginPath();
  ctx.moveTo(x1, y);
  ctx.lineTo(x2, y);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(x1, y - 6);
  ctx.lineTo(x1, y + 6);
  ctx.moveTo(x2, y - 6);
  ctx.lineTo(x2, y + 6);
  ctx.stroke();

  ctx.font = "12px ui-monospace, Menlo, Consolas, monospace";
  // 🔧 Use simple concatenation to avoid template-literal parsing issues
  ctx.fillText("λ ≈ " + Math.round(x2 - x1) + " px", (x1 + x2) / 2, y - 8);

  ctx.restore();
}


/* ------------------------------ UI Bits ------------------------------ */
function Card({title, children}){ return (<div style={S.card}><div style={S.cardTitle}>{title}</div>{children}</div>); }
function SubCard({title, children}){ return (<div style={S.subCard}><div style={S.subCardTitle}>{title}</div>{children}</div>); }
function Row({children, wrap, style}){ return (<div style={{...S.row, flexWrap:wrap?"wrap":"nowrap", ...(style||{})}}>{children}</div>); }
function SegButton({active, onClick, children, small}){ return (<button onClick={onClick} style={S.segBtn(active, small)}>{children}</button>); }
function Line({label, value}){ return (<div style={S.lineHeader}><span>{label}</span><strong>{value}</strong></div>); }
function Hint({children}){ return (<div style={S.hint}>{children}</div>); }

function Readouts({Apx,A,Lpx,L,f,T,k,w,v,vpx,P,onClickBadge,glossaryKey,onCloseGlossary}){
  const Badge = ({keyId,label,value,sub}) => (
    <button onClick={()=>onClickBadge(label)} style={S.badge} title={`Click for ${label} info`}>
      <span style={S.badgeKey}>{label}</span>
      <span style={S.badgeVal}>{value}</span>
      {sub && <span style={S.badgeSub}>({sub})</span>}
    </button>
  );
  return (
    <div style={S.readouts}>
      <Badge keyId="A" label="A" value={fmtSI(A,"m",3)} sub={`${Math.round(Apx)} px`} />
      <Badge keyId="λ" label="λ" value={fmtSI(L,"m",3)} sub={`${Math.round(Lpx)} px`} />
      <Badge keyId="f" label="f" value={`${f.toFixed(2)} Hz`} />
      <Badge keyId="T" label="T" value={`${isFinite(T)?T.toFixed(2):"∞"} s`} />
      <Badge keyId="k" label="k" value={`${k.toFixed(3)} rad/m`} />
      <Badge keyId="ω" label="ω" value={`${w.toFixed(2)} rad/s`} />
      <Badge keyId="v" label="v" value={`${v.toFixed(2)} m/s`} sub={`${Math.round(vpx)} px/s`} />
      <Badge keyId="P" label="P" value={`~ ${(P).toFixed(0)}`} />
      {glossaryKey && <GlossaryPopover keyName={glossaryKey} onClose={onCloseGlossary} />}
    </div>
  );
}

function GlossaryPopover({keyName, onClose}){
  const items = {
    "A": { title:"Amplitude (A)", text:"Maximum displacement from equilibrium. In transverse waves: crest height. In longitudinal waves: maximum particle shift along travel." },
    "λ": { title:"Wavelength (λ)", text:"Distance between repeating features (crest-to-crest or compression-to-compression). Related via v=fλ." },
    "f": { title:"Frequency (f)", text:"Oscillations per second (Hz). With fixed speed v, higher f means shorter λ." },
    "T": { title:"Period (T)", text:"Time for one full cycle. T = 1/f." },
    "k": { title:"Wavenumber (k)", text:"Spatial angular frequency: k=2π/λ (rad/m). Big k means more cycles per meter." },
    "ω": { title:"Angular frequency (ω)", text:"Temporal angular frequency: ω=2πf (rad/s). Governs how fast the phase spins in time." },
    "v": { title:"Wave speed (v)", text:"Pattern speed set by medium. For strings: v=√(T/μ). For sound (air): v≈331+0.6T (m/s). Shallow water: v≈√(gh)." },
    "P": { title:"Power proxy (P)", text:"Illustrative A²f² measure of conveyed energy; real constants depend on the medium." }
  };
  const it = items[keyName] || {title:keyName, text:"—"};
  return (
    <div style={S.popWrap}>
      <div style={S.popCard}>
        <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6}}>
          <div style={{fontWeight:700}}>{it.title}</div>
          <button onClick={onClose} style={S.ghostBtnSmall}>Close</button>
        </div>
        <div style={{color:"#cbd5e1", fontSize:14, lineHeight:1.6}}>{it.text}</div>
      </div>
    </div>
  );
}

function Tips({mode}) {
  return (
    <div style={S.tips}>
      <b>Tips</b>
      <ul style={{margin:6, paddingLeft:18, lineHeight:1.6}}>
        {mode==="transverse" && (<>
          <li>Particles move <u>perpendicular</u> to travel; crests/troughs follow A.</li>
          <li>Lock v, raise f → λ shrinks so v=fλ remains constant.</li>
        </>)}
        {mode==="longitudinal" && (<>
          <li><u>Parallel</u> particle motion. Dark = compression; light = rarefaction.</li>
          <li>Use <b>Comoving</b> or <b>Strobe</b> in the toolbar for sound clarity.</li>
        </>)}
        {mode==="standing" && (<>
          <li>Nodes (still) every ≈ λ/2; antinodes swing maximally.</li>
        </>)}
      </ul>
    </div>
  );
}

/* --------------------------- Practice --------------------------- */
function PracticePanel({ running, session, difficulty, onSetDifficulty, onStart, onAnswered, onRestartSimilar }) {
  return (
    <div style={S.practiceBox}>
      <div style={S.practiceHeader}>Practice</div>
      {!running || !session ? (
        <div style={{display:"grid", gap:8}}>
          <div>Default: <b>Mixed skills</b>.</div>
          <div style={{display:"flex", alignItems:"center", gap:8, flexWrap:"wrap"}}>
            <label>Difficulty</label>
            <Row wrap>
              <SegButton small active={difficulty==="easy"} onClick={()=>onSetDifficulty("easy")}>Easy</SegButton>
              <SegButton small active={difficulty==="med"} onClick={()=>onSetDifficulty("med")}>Medium</SegButton>
              <SegButton small active={difficulty==="hard"} onClick={()=>onSetDifficulty("hard")}>Hard</SegButton>
            </Row>
          </div>
          <button onClick={onStart} style={S.primaryBig}>Start Practice</button>
          <div style={S.hint}>You’ll get 10 mixed questions. “Show steps” explains each one; “Try similar” regenerates with new numbers.</div>
        </div>
      ) : (
        <PracticeSession session={session} onAnswered={onAnswered} onRestartSimilar={onRestartSimilar} />
      )}
    </div>
  );
}

function PracticeSession({ session, onAnswered, onRestartSimilar }) {
  const p = session.problems[session.idx];
  if (!p) {
    return (
      <div>
        <div style={{marginBottom:6}}><b>Done!</b> Score: {session.correct}/{session.problems.length}</div>
        <div style={{display:"flex", gap:8}}>
          <button onClick={onRestartSimilar} style={S.primaryBtnSmall}>Try similar set</button>
        </div>
      </div>
    );
  }
  return <ProblemView p={p} onResult={onAnswered} />;
}

function ProblemView({ p, onResult }) {
  const [selectedIdx, setSelectedIdx] = useState(null);
  const [userAnswer, setUserAnswer] = useState("");
  const [feedback, setFeedback] = useState(null);
  const [showSteps, setShowSteps] = useState(false);

  function check() {
    if (p.choices) {
      if (selectedIdx == null) return;
      const ok = selectedIdx === p.correct;
      setFeedback(ok ? "correct" : "wrong");
      onResult(ok);
    } else {
      const norm = s => String(s).trim().toLowerCase();
      const ok = norm(userAnswer) === norm(p.answer);
      setFeedback(ok ? "correct" : "wrong");
      onResult(ok);
    }
  }

  return (
    <div style={{display:"grid", gap:8}}>
      <div style={{fontWeight:700}}>{p.prompt}</div>
      {p.choices ? (
        <div style={{display:"grid", gap:6}}>
          {p.choices.map((c,i)=>(
            <label key={i} style={S.choiceLbl}>
              <input type="radio" name="mcq" checked={selectedIdx===i} onChange={()=>setSelectedIdx(i)}/>
              <span>{String(c)}</span>
            </label>
          ))}
        </div>
      ) : (
        <div style={{display:"flex", gap:6}}>
          <input value={userAnswer} onChange={(e)=>setUserAnswer(e.target.value)} placeholder="Your answer" style={S.input}/>
          <button onClick={check} style={S.primaryBtnSmall}>Check</button>
        </div>
      )}
      {p.choices && <button onClick={check} style={S.primaryBtnSmall}>Check</button>}
      {feedback && (<div>{feedback==="correct" ? <span style={{color:"#34d399"}}>✅ Correct</span> : <span style={{color:"#fca5a5"}}>❌ Not quite</span>}</div>)}
      <button onClick={()=>setShowSteps(s=>!s)} style={S.ghostBtnSmall}>{showSteps?"Hide":"Show"} steps</button>
      {showSteps && (
        <div style={S.stepsBox}>
          <ol style={{margin:"6px 0 0 16px", lineHeight:1.6}}>{p.steps.map((s,i)=>(<li key={i}>{s}</li>))}</ol>
          <div style={{marginTop:8, color:"#cbd5e1"}}><b>Explanation:</b> {p.explanation}</div>
        </div>
      )}
    </div>
  );
}

/* -------------------- Problem Generator (SI-aware) -------------------- */
function genProblem(skill, difficulty, ctx) {
  const seed = Math.floor(Math.random()*1e9)>>>0;
  const rng = mulberry32(seed);
  if (skill==="mixed") {
    const skills = ["vfl","lambda","freq","standing","concept"];
    return genProblem(skills[Math.floor(rng()*skills.length)], difficulty, ctx);
  }
  if (skill==="vfl") return genComputeV(rng, difficulty, ctx);
  if (skill==="lambda") return genSolveLambda(rng, difficulty, ctx);
  if (skill==="freq") return genSolveFreq(rng, difficulty, ctx);
  if (skill==="standing") return genStandingNodes(rng, difficulty, ctx);
  return genConceptTF(rng);
}
function genComputeV(rng, diff, ctx) {
  const f = round(rand(rng, 0.4, 1.6, diff), 2);
  const Lm = round(rand(rng, 0.2, 1.4, diff), 2);
  const v = round(f * Lm, 2);
  const prompt = `Given frequency f = ${f} Hz and wavelength λ = ${Lm.toFixed(2)} m, compute the wave speed v (m/s).`;
  const steps = ["Use v = f × λ.", `Substitute: v = ${f} × ${Lm.toFixed(2)}.`, `Compute: v = ${v.toFixed(2)} m/s.`];
  const explanation = "In a fixed medium, speed v is a medium property; f and λ trade off so that v=fλ.";
  const choices = shuffle(rng, [
    `${v.toFixed(2)} m/s`,
    `${(v+0.1*Lm).toFixed(2)} m/s`,
    `${Math.max(0,v-0.1*Lm).toFixed(2)} m/s`,
    `${(Lm/f).toFixed(2)} m/s`,
  ]);
  const correct = choices.indexOf(`${v.toFixed(2)} m/s`);
  return { id:`v-${Date.now()}`, skill:"vfl", type:"mcq", prompt, choices, correct, answer:`${v.toFixed(2)} m/s`, steps, explanation };
}
function genSolveLambda(rng, diff, ctx) {
  const v = round(rand(rng, 0.8, 10, diff), 2);
  const f = round(rand(rng, 0.4, 1.6, diff), 2);
  const L = round(v / Math.max(1e-6, f), 2);
  const prompt = `Given v = ${v.toFixed(2)} m/s and f = ${f.toFixed(2)} Hz, find λ in meters.`;
  const steps = ["Start from v = fλ.", "Rearrange: λ = v / f.", `Compute: λ = ${v.toFixed(2)} / ${f.toFixed(2)} = ${L.toFixed(2)} m.`];
  const explanation = "With speed fixed, higher frequency means shorter wavelength.";
  const choices = shuffle(rng, [
    `${L.toFixed(2)} m`,
    `${(v*f).toFixed(2)} m`,
    `${(v/(2*f)).toFixed(2)} m`,
    `${(v/(f+0.2)).toFixed(2)} m`,
  ]);
  const correct = choices.indexOf(`${L.toFixed(2)} m`);
  return { id:`L-${Date.now()}`, skill:"lambda", type:"mcq", prompt, choices, correct, answer:`${L.toFixed(2)} m`, steps, explanation };
}
function genSolveFreq(rng, diff, ctx) {
  const v = round(rand(rng, 0.8, 10, diff), 2);
  const L = round(rand(rng, 0.2, 1.4, diff), 2);
  const f = round(v / Math.max(1e-6, L), 2);
  const prompt = `Given v = ${v.toFixed(2)} m/s and λ = ${L.toFixed(2)} m, find f in Hz.`;
  const steps = ["Use v = fλ.", "Rearrange: f = v / λ.", `Compute: f = ${v.toFixed(2)} / ${L.toFixed(2)} = ${f.toFixed(2)} Hz.`];
  const explanation = "Frequency is cycles per second; with v fixed, longer λ lowers f.";
  const choices = shuffle(rng, [
    `${f.toFixed(2)} Hz`,
    `${(f*2).toFixed(2)} Hz`,
    `${Math.max(0.01,f/2).toFixed(2)} Hz`,
    `${(L/v).toFixed(2)} Hz`,
  ]);
  const correct = choices.indexOf(`${f.toFixed(2)} Hz`);
  return { id:`f-${Date.now()}`, skill:"freq", type:"mcq", prompt, choices, correct, answer:`${f.toFixed(2)} Hz`, steps, explanation };
}
function genStandingNodes(rng, diff, ctx) {
  const Lstring = round(rand(rng, 0.8, 2.2, diff), 2);
  const n = Math.floor(rand(rng, 2, 6, diff));
  const lam = round(2*Lstring/n, 2);
  const positions = Array.from({length:n+1}, (_,i)=> round(i*(Lstring/n),2));
  const prompt = `A string of length ${Lstring.toFixed(2)} m supports a standing wave at harmonic n=${n}. Find λ and list node positions (m).`;
  const steps = [
    "Fixed-fixed: L = n(λ/2).",
    `Solve: λ = 2L/n = 2×${Lstring.toFixed(2)}/${n} = ${lam.toFixed(2)} m.`,
    `Nodes every λ/2 = ${(lam/2).toFixed(2)} m: ${positions.join(", ")} m.`
  ];
  const explanation = "Nodes are spaced by λ/2 from the ends.";
  const answer = `λ=${lam.toFixed(2)} m; nodes at x=${positions.join(" m, ")} m`;
  return { id:`stand-${Date.now()}`, skill:"standing", type:"text", prompt, steps, explanation, answer };
}
function genConceptTF(rng) {
  const facts = [
    { q:"With v fixed, doubling f doubles λ.", a:false, why:"λ = v/f; doubling f halves λ." },
    { q:"In a longitudinal wave, particle motion is parallel to propagation.", a:true, why:"Definition of longitudinal motion." },
    { q:"Power scales roughly as A²f² (illustrative).", a:true, why:"For many linear waves, transported power behaves ~A²f²." },
    { q:"k = 2π/λ.", a:true, why:"By definition of spatial angular frequency." },
  ];
  const F = facts[Math.floor(rng()*facts.length)];
  const steps = [F.a ? "This matches the defining relation." : "Check v=fλ: λ inversely changes with f when v is fixed."];
  const explanation = F.why;
  const choices = ["True","False"];
  const correct = F.a ? 0 : 1;
  return { id:`tf-${Date.now()}`, skill:"concept", type:"mcq", prompt: F.q, choices, correct, answer: F.a?"True":"False", steps, explanation };
}

/* RNG helpers */
function mulberry32(a){ return function(){ let t=a+=0x6D2B79F5; t=Math.imul(t^(t>>>15), t|1); t^=t+Math.imul(t^(t>>>7), t|61); return ((t^(t>>>14))>>>0)/4294967296; } }
function rand(rng, lo, hi, diff){
  const extra = diff==="med"?0.15:diff==="hard"?0.3:0;
  const span = (hi-lo)*(1+extra);
  return lo + rng()*span;
}
function round(x,d){ const p=10**d; return Math.round(x*p)/p; }
function shuffle(rng, arr){ const a=[...arr]; for (let i=a.length-1;i>0;i--){ const j=Math.floor(rng()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }

/* ----------------------------- Learn Drawer ----------------------------- */
function InfoDrawer({ page, onClose, onNavigate, tryIt, detailLevelKey }) {
  const [detail, setDetail] = useState( safeStore.get(detailLevelKey, 1) ); // 0 plain, 1 technical, 2 derivation
  useEffect(()=>{ safeStore.set(detailLevelKey, detail); },[detail, detailLevelKey]);
  const Tab = (id, label) => <button onClick={()=>onNavigate(id)} style={S.tab(page===id)}>{label}</button>;
  const Article = ({title, children}) => (<article style={{marginBottom:16}}><h3 style={{margin:"8px 0 6px 0"}}>{title}</h3><div style={{color:"#cbd5e1", lineHeight:1.6, fontSize:14}}>{children}</div></article>);
  const TwoCol = ({plain, sci, deriv}) => (
    <div style={S.twocol}>
      <div><b>Plain language</b><div style={S.plain}>{plain}</div></div>
      <div><b>{detail===2?"Derivation":"Scientific"}</b><div style={S.sci}>{detail===2 ? (deriv || sci) : sci}</div></div>
    </div>
  );
  const Try = ({label, action}) => <button onClick={()=>tryIt(action)} style={S.linkBtn}>{label}</button>;

  return (
    <div style={S.infoWrap}>
      <div style={S.infoCard}>
        <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6}}>
          <div style={{fontWeight:700}}>Learn</div>
          <div style={{display:"flex", gap:8, alignItems:"center"}}>
            <label style={{fontSize:12}}>Depth</label>
            <select value={detail} onChange={(e)=>setDetail(parseInt(e.target.value))} style={S.toolbarSelect}>
              <option value={0}>Plain</option>
              <option value={1}>Scientific</option>
              <option value={2}>Derivation</option>
            </select>
            <button onClick={onClose} style={S.ghostBtnSmall}>Close</button>
          </div>
        </div>
        <div style={{display:"flex", gap:6, flexWrap:"wrap", marginBottom:6}}>
          {Tab("overview","Overview")}
          {Tab("amplitude","Amplitude (A)")}
          {Tab("wavelength","Wavelength (λ)")}
          {Tab("frequency","Frequency (f)")}
          {Tab("period","Period (T)")}
          {Tab("wavenumber","Wavenumber (k)")}
          {Tab("omega","Angular freq (ω)")}
          {Tab("vfl","Speed v = fλ")}
          {Tab("transverse","Transverse")}
          {Tab("longitudinal","Longitudinal")}
          {Tab("standing","Standing")}
          {Tab("acoustics","Acoustics")}
          {Tab("energy","Energy & Power")}
          {Tab("experiments","Experiments")}
          {Tab("faq","FAQ")}
        </div>

        <div style={S.infoScroll}>
          {page==="overview" && (<>
            <Article title="Welcome">
              <TwoCol
                plain={<p>Change amplitude, wavelength, and frequency to see how waves behave. Badges above the canvas show core values. Click the <b>λ</b> badge to draw a ruler and measure wavelength.</p>}
                sci={<p>{String.raw`We render scalar waves with phase \(kx-\omega t+\phi\). Traveling: \(y=A\sin(kx-\omega t+\phi)\); standing: \(y=2A\sin(kx)\cos(\omega t+\phi)\). Readouts use SI via your calibration.`}</p>}
                deriv={<p>{String.raw`From the 1D wave equation \(y_{tt}=c^2 y_{xx}\), plane wave solutions \(y=A\sin(kx-\omega t)\) obey \(\omega=ck\). Standing waves arise from the superposition of \(+k\) and \(-k\) with equal \(\omega\).`}</p>}
              />
              <Try label="Try: show wavelength ruler" action="measure-lambda" />
            </Article>
          </>)}

          {page==="amplitude" && (
            <Article title="Amplitude (A)">
              <TwoCol
                plain={<p>Amplitude is how far points move from the middle. Bigger A → taller crests (transverse) or stronger compressions (longitudinal).</p>}
                sci={<p>In many linear media, carried power scales like {String.raw`\(P\propto A^2 f^2\)`}. We show an illustrative proxy.</p>}
                deriv={<p>{String.raw`For a string with linear density \(\mu\) and tension \(T\), the time-averaged power of \(y=A\sin(kx-\omega t)\) is \(\langle P\rangle=\tfrac{1}{2}\mu \omega^2 A^2 v\).`}</p>}
              />
            </Article>
          )}

          {page==="wavelength" && (
            <Article title="Wavelength (λ)">
              <TwoCol
                plain={<p>Distance between repeating features—crest to crest or compression to compression.</p>}
                sci={<p>{String.raw`\(k=2\pi/\lambda\). In non-dispersive media, \(v=\omega/k=f\lambda\).`}</p>}
                deriv={<p>{String.raw`From spatial periodicity \(y(x+\lambda,t)=y(x,t)\), the phase change over \(\lambda\) is \(2\pi\): \(k\lambda=2\pi \Rightarrow k=2\pi/\lambda\).`}</p>}
              />
              <Try label="Try: measure λ" action="measure-lambda" />
            </Article>
          )}

          {page==="frequency" && (
            <Article title="Frequency (f)">
              <TwoCol
                plain={<p>How many cycles per second (Hz). If speed stays the same, higher f squeezes the ripples together (smaller λ).</p>}
                sci={<p>{String.raw`\(\omega=2\pi f\). With fixed \(v\), \(\lambda=v/f\).`}</p>}
                deriv={<p>{String.raw`From \(T=1/f\), angular frequency \(\omega=2\pi/T=2\pi f\).`}</p>}
              />
            </Article>
          )}

          {page==="period" && (
            <Article title="Period (T)">
              <TwoCol
                plain={<p>Time for one full cycle. If f=2 Hz → T=0.5 s.</p>}
                sci={<p>{String.raw`\(T=1/f\) for periodic motion.`}</p>}
                deriv={<p>{String.raw`Period is the least \(T>0\) such that \(y(t+T)=y(t)\).`}</p>}
              />
            </Article>
          )}

          {page==="wavenumber" && (
            <Article title="Wavenumber (k)">
              <TwoCol
                plain={<p>How tightly the wave is packed in space. Bigger k → more cycles per meter.</p>}
                sci={<p>{String.raw`\(k=2\pi/\lambda\). Spatial analog of \(\omega\).`}</p>}
                deriv={<p>{String.raw`From the Fourier representation \(y(x)=\int \tilde{y}(k)e^{ikx}dk\), \(k\) indexes spatial frequency in rad/m.`}</p>}
              />
            </Article>
          )}

          {page==="omega" && (
            <Article title="Angular frequency (ω)">
              <TwoCol
                plain={<p>How fast the phase spins in time (radians per second).</p>}
                sci={<p>{String.raw`\(\omega=2\pi f\). Phase \(\phi(t)=\omega t\) for simple harmonic motion.`}</p>}
                deriv={<p>{String.raw`\(\omega = d\phi/dt\) for a uniform rotator; harmonic motion projects this rotation on an axis.`}</p>}
              />
            </Article>
          )}

          {page==="vfl" && (
            <Article title="Wave speed (v = fλ)">
              <TwoCol
                plain={<p>In one medium, wave speed is fixed. Spin faster (raise f) → ripples get closer (smaller λ) so v stays the same.</p>}
                sci={<p>{String.raw`With constant medium speed \(v\), \(v=\omega/k=f\lambda\). String: \(v=\sqrt{T/\mu}\). Air near 20 °C: \(v\approx331+0.6T\) m/s. Shallow water: \(v\approx\sqrt{gh}\).`}</p>}
                deriv={<p>{String.raw`From the 1D wave equation \(y_{tt}=c^2 y_{xx}\), plane waves have \(\omega=ck\Rightarrow v=\omega/k\).`}</p>}
              />
              <Try label="Mini-lab: halve λ" action="mini-halve" />
            </Article>
          )}

          {page==="transverse" && (
            <Article title="Transverse">
              <TwoCol
                plain={<p>Points move up and down while the pattern travels sideways.</p>}
                sci={<p>{String.raw`\(y(x,t)=A\sin(kx-\omega t+\phi)\). In this mode, displacement ⟂ propagation.`}</p>}
                deriv={<p>{String.raw`Solutions arise from linearizing small-slope string motion; transverse displacement obeys the wave equation.`}</p>}
              />
            </Article>
          )}

          {page==="longitudinal" && (
            <Article title="Longitudinal">
              <TwoCol
                plain={<p>Points move back and forth along the travel direction. We shade compressions darker, rarefactions lighter.</p>}
                sci={<p>{String.raw`Displacement \(s(x,t)\parallel x\). Pressure and density vary \(\propto \cos(kx-\omega t)\). Particle velocity \(u\propto \sin(kx-\omega t)\).`}</p>}
                deriv={<p>{String.raw`Linear acoustics: \(p'=\rho_0 c\,u\), and \(u_t=-\frac{1}{\rho_0}p'_x\) → wave equations for \(p'\) and \(u\).`}</p>}
              />
            </Article>
          )}

          {page==="standing" && (
            <Article title="Standing waves">
              <TwoCol
                plain={<p>Two opposite waves overlap: some points don’t move (nodes), others swing big (antinodes).</p>}
                sci={<p>{String.raw`Fixed-fixed string length \(L\) supports \(L=n\lambda/2\) modes. Node spacing = λ/2.`}</p>}
                deriv={<p>{String.raw`Boundary conditions \(y(0)=y(L)=0\) → \(k_n=n\pi/L\), \(\lambda_n=2L/n\).`}</p>}
              />
              <Try label="Try: show standing" action="standing-nodes" />
            </Article>
          )}

          {page==="acoustics" && (
            <Article title="Acoustics (plane waves)">
              <TwoCol
                plain={<p>Sound is a longitudinal pressure wave. Darker bands = compressions (high pressure), lighter = rarefactions (low). Particle velocity points along travel and is proportional to pressure.</p>}
                sci={
                  <p>
                    {String.raw`Small-signal linear acoustics: \(p'(x,t)=p_0\cos(kx-\omega t)\), \(u(x,t)=\frac{p'}{\rho_0 c}\). With displacement amplitude \(\xi_0\), \(p_0=\rho_0 c\,\omega \xi_0\). Intensity \(I=\langle p'u\rangle = \frac{p_{\mathrm{rms}}^2}{\rho_0 c}\). SPL \(=20\log_{10}(p_{\mathrm{rms}}/20\,\mu\mathrm{Pa})\).`}
                  </p>
                }
                deriv={<p>{String.raw`From mass and momentum conservation (Euler + continuity) linearized about \((\rho_0,p_0)\), we obtain \(p'_{tt}=c^2 p'_{xx}\) with \(c=\sqrt{\gamma p_0/\rho_0}\) (ideal gas).`}</p>}
              />
              <ul>
                <li>Speed of sound: {String.raw`\(c\approx331+0.6T\)`} m/s (mild humidity dependence).</li>
                <li>Click <b>🎤</b> to match simulation to your voice; freeze & scrub to study a captured snippet.</li>
              </ul>
            </Article>
          )}

          {page==="energy" && (
            <Article title="Energy & Power">
              <TwoCol
                plain={<p>More amplitude and higher frequency usually mean more energy moving along the wave.</p>}
                sci={<p>{String.raw`In many linear waves, \(\langle P\rangle \propto A^2 f^2\). Exact constants depend on medium and geometry.`}</p>}
                deriv={<p>{String.raw`For a string: \(\langle P\rangle=\tfrac{1}{2}\mu \omega^2 A^2 v\). For sound: intensity \(I = p_{\rm rms}^2/(\rho_0 c)\).`}</p>}
              />
            </Article>
          )}

          {page==="experiments" && (
            <Article title="Experiments">
              <ul>
                <li>Lock v, double f → verify λ halves. <Try label="Slow motion" action="slowmo" /></li>
                <li>Standing waves: measure node spacing ≈ λ/2. <Try label="Show standing" action="standing-nodes" /></li>
                <li>Click λ badge to practice measuring wavelength. <Try label="Show ruler" action="measure-lambda" /></li>
                <li>Mini-lab: measure k using ruler. <Try label="Mini-lab" action="mini-k" /></li>
              </ul>
            </Article>
          )}

          {page==="faq" && (
            <Article title="FAQ & Misconceptions">
              <ul>
                <li><b>“If frequency increases, speed increases.”</b> Not in a fixed medium—λ decreases instead.</li>
                <li><b>“Particles travel with the wave.”</b> They oscillate; energy/phase propagate.</li>
                <li><b>“Longitudinal visuals look crowded.”</b> Use Comoving/Strobe; the app also auto-tunes particle count/size.</li>
              </ul>
            </Article>
          )}
        </div>
      </div>
    </div>
  );
}

/* ----------------------------- Styles ----------------------------- */
const S = {
  page: { background:"#0b1220", minHeight:"100vh", color:"#e5e7eb" },
  container: { maxWidth:1320, margin:"0 auto", padding:"24px" },
  header: { display:"flex", alignItems:"flex-end", justifyContent:"space-between", gap:12, marginBottom:16, flexWrap:"wrap" },
  title: { margin:0, fontSize:28, fontWeight:700 },
  subtitle: { margin:"6px 0 0 0", color:"#94a3b8", fontSize:14 },

  columns: { display:"grid", gridTemplateColumns:"340px 1fr 360px", gap:12 },

  dock: {
    height:560, display:"flex", flexDirection:"column",
    background:"rgba(15,23,42,0.9)", border:"1px solid rgba(255,255,255,0.08)", borderRadius:16, padding:12,
    boxShadow:"0 6px 18px rgba(0,0,0,0.25)", 
    // 🔧 allow internal scroll so nothing is hidden
    overflowY:"auto", overflowX:"hidden", minWidth:300
  },

  center: { display:"flex", flexDirection:"column", gap:10, minWidth:420 },
  canvasWrap: {
    position:"relative", width:"100%", height:560, maxWidth:960,
    background:"#0f172a", border:"1px solid rgba(255,255,255,0.08)", borderRadius:16,
    boxShadow:"0 8px 24px rgba(0,0,0,0.35)", overflow:"hidden"
  },

  rightCol: { display:"flex", flexDirection:"column", gap:10, minWidth:320 },

  settingsBox: {
    height:340, background:"rgba(15,23,42,0.9)", border:"1px solid rgba(255,255,255,0.08)", borderRadius:16,
    boxShadow:"0 6px 18px rgba(0,0,0,0.25)", display:"flex", flexDirection:"column"
  },
  settingsHeader: { padding:"10px 12px", fontWeight:700, borderBottom:"1px solid rgba(255,255,255,0.08)" },
  settingsScroll: { padding:"10px 12px", overflowY:"auto" },

  // 🔧 let Practice scroll so longer items are visible
  practiceBox: { height:200, overflowY:"auto", background:"rgba(15,23,42,0.9)", border:"1px solid rgba(255,255,255,0.08)", borderRadius:16, boxShadow:"0 6px 18px rgba(0,0,0,0.25)", padding:10, display:"flex", flexDirection:"column" },
  practiceHeader: { fontWeight:700, marginBottom:6, borderBottom:"1px solid rgba(255,255,255,0.08)", paddingBottom:4 },

  primaryBig: { background:"#34d399", color:"#0b1220", fontWeight:800, padding:"12px 16px", borderRadius:14, border:"none", cursor:"pointer", fontSize:16, boxShadow:"0 5px 12px rgba(0,0,0,0.3)" },

  card: { background:"rgba(15,23,42,0.9)", border:"1px solid rgba(255,255,255,0.08)", borderRadius:16, padding:12, marginBottom:10 },
  cardTitle: { fontWeight:700, marginBottom:6 },
  subCard: { background:"#0b1220", border:"1px solid rgba(255,255,255,0.08)", borderRadius:12, padding:10, marginBottom:10 },
  subCardTitle: { fontWeight:700, marginBottom:4 },

  row: { display:"flex", alignItems:"center", justifyContent:"space-between", gap:8, margin:"6px 0" },
  slider: { width:"100%" },

  segBtn: (active, small)=>({
    padding: small ? "6px 8px" : "8px 10px", borderRadius:10, cursor:"pointer", border:"1px solid rgba(255,255,255,0.1)",
    background: active ? "#34d399" : "#111827", color: active ? "#0b1220" : "#e5e7eb",
    fontWeight:700, textAlign:"center", flex: small ? "none" : 1, minWidth: small ? 0 : 0
  }),
  lineHeader: { display:"flex", alignItems:"center", justifyContent:"space-between", fontSize:13, marginBottom:4 },
  hint: { color:"#94a3b8", fontSize:12, marginTop:4 },

  readouts: { display:"flex", gap:6, flexWrap:"wrap", background:"rgba(15,23,42,0.9)", border:"1px solid rgba(255,255,255,0.08)", borderRadius:12, padding:"6px 8px", alignItems:"center" },
  badge: { display:"inline-flex", alignItems:"center", gap:6, background:"#0f172a", border:"1px solid rgba(255,255,255,0.08)", borderRadius:10, padding:"4px 8px", cursor:"pointer" },
  badgeKey: { fontFamily:"ui-monospace, Menlo, Consolas, monospace", color:"#93c5fd", fontSize:12 },
  badgeVal: { fontFamily:"ui-monospace, Menlo, Consolas, monospace", fontSize:12, color:"#e5e7eb" },
  badgeSub: { fontFamily:"ui-monospace, Menlo, Consolas, monospace", fontSize:11, color:"#94a3b8" },

  tips: { background:"rgba(15,23,42,0.9)", border:"1px solid rgba(255,255,255,0.08)", borderRadius:12, padding:10, color:"#cbd5e1" },

  choiceLbl: { display:"flex", gap:8, alignItems:"center", background:"#0b1220", border:"1px solid rgba(255,255,255,0.08)", padding:"6px 8px", borderRadius:10 },
  input: { flex:1, minWidth:120, background:"#0b1220", color:"#e5e7eb", border:"1px solid rgba(255,255,255,0.1)", borderRadius:10, padding:"6px 8px" },

  primaryBtn: { background:"#34d399", color:"#0b1220", fontWeight:700, padding:"8px 12px", border:"none", borderRadius:14, cursor:"pointer", boxShadow:"0 4px 10px rgba(0,0,0,0.25)" },
  ghostBtn: { background:"#111827", color:"#e5e7eb", padding:"8px 12px", border:"1px solid rgba(255,255,255,0.1)", borderRadius:14, cursor:"pointer" },
  ghostBtnSmall: { background:"#111827", color:"#e5e7eb", padding:"6px 10px", border:"1px solid rgba(255,255,255,0.1)", borderRadius:12, cursor:"pointer" },
  primaryBtnSmall: { background:"#34d399", color:"#0b1220", padding:"6px 10px", borderRadius:12, cursor:"pointer", border:"none" },
  linkBtn: { background:"#0b1220", color:"#93c5fd", padding:"4px 8px", border:"1px solid rgba(147,197,253,0.3)", borderRadius:10, cursor:"pointer", fontSize:12 },

  // Toolbar
  toolbar: { display:"flex", gap:8, alignItems:"center", background:"rgba(15,23,42,0.9)", border:"1px solid rgba(255,255,255,0.08)", borderRadius:10, padding:"6px 8px", justifyContent:"space-between", flexWrap:"wrap" },
  toolbarBtn: { background:"#111827", color:"#e5e7eb", padding:"6px 10px", border:"1px solid rgba(255,255,255,0.1)", borderRadius:10, cursor:"pointer" },
  toolbarSelect: { background:"#0b1220", color:"#e5e7eb", border:"1px solid rgba(255,255,255,0.1)", borderRadius:10, padding:"4px 6px" },
  toolbarLabel: { color:"#cbd5e1", fontSize:12 },
  toolbarSmall: { color:"#cbd5e1", fontSize:12 },

  tipBubble: { position:"absolute", top:10, left:"50%", transform:"translateX(-50%)", background:"rgba(15,23,42,0.96)", border:"1px solid rgba(255,255,255,0.12)", borderRadius:12, padding:"10px 12px", boxShadow:"0 10px 28px rgba(0,0,0,0.35)", maxWidth:520 },
  labBubble: { position:"absolute", bottom:10, right:10, background:"rgba(15,23,42,0.96)", border:"1px solid rgba(255,255,255,0.12)", borderRadius:12, padding:"10px 12px", boxShadow:"0 10px 28px rgba(0,0,0,0.35)", maxWidth:320 },

  // Popover
  popWrap: { position:"fixed", inset:0, background:"transparent" },
  popCard: { position:"absolute", top:86, left:"50%", transform:"translateX(-50%)", width:"min(520px, 92vw)", background:"#0f172a", border:"1px solid rgba(255,255,255,0.12)", borderRadius:12, padding:12, boxShadow:"0 12px 30px rgba(0,0,0,0.4)" },

  // Learn drawer
  infoWrap: { position:"fixed", inset:0, background:"rgba(0,0,0,0.45)" },
  infoCard: { position:"absolute", top:0, right:0, bottom:0, width:"min(560px, 95vw)", background:"#0f172a", borderLeft:"1px solid rgba(255,255,255,0.1)", padding:12, boxShadow:"-6px 0 20px rgba(0,0,0,0.4)", display:"flex", flexDirection:"column" },
  tab: (active)=>({ padding:"4px 8px", borderRadius:10, border:"1px solid rgba(255,255,255,0.1)", background: active ? "#1f2937" : "#0b1220", color:"#e5e7eb", fontSize:12, cursor:"pointer" }),
  infoScroll: { marginTop:6, overflowY:"auto", paddingRight:6 },
  twocol: { display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 },
  plain: { color:"#e5e7eb" },
  sci: { color:"#cbd5e1", fontFamily:"ui-monospace, Menlo, Consolas, monospace" },

  // Misc
  fpsPill: { background:"#0f172a", border:"1px solid rgba(255,255,255,0.1)", borderRadius:12, padding:"4px 8px", fontFamily:"ui-monospace, Menlo, Consolas, monospace", fontSize:12 },

  stepBtn: { background:"#111827", color:"#e5e7eb", border:"1px solid rgba(255,255,255,0.1)", borderRadius:8, padding:"4px 8px", cursor:"pointer" },
};

/* --------------------------- Export with boundary --------------------------- */
export default function WaveLab(){
  return (
    <ErrorBoundary>
      <WaveLabInner />
    </ErrorBoundary>
  );
}
