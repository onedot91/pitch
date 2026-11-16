// 가짜 악기 소리로 측정기를 시험함.  실행: node test/tracker.test.js
const { createPitchTracker } = require('../tracker.js');

const SR = 48000, WIN = 2048, TICK = 0.03, SPLIT = 415;

// 시드 고정 난수 (매번 같은 결과)
let seed = 1;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;

function render(seconds, add) {
  const x = new Float32Array(Math.ceil(seconds * SR));
  add(x);
  return x;
}
const sine = (x, f, amp, t0, tau, dur) => {
  const a = Math.floor(t0 * SR), b = Math.min(x.length, Math.floor((t0 + dur) * SR));
  for (let i = a; i < b; i++) { const t = (i - a) / SR; x[i] += amp * Math.exp(-t / tau) * Math.sin(2 * Math.PI * f * t); }
};
const hum = (x, f, amp) => { for (let i = 0; i < x.length; i++) x[i] += amp * Math.sin(2 * Math.PI * f * i / SR); };
const noise = (x, amp, t0 = 0, dur = Infinity, tau = Infinity) => {
  const a = Math.floor(t0 * SR), b = Math.min(x.length, Math.floor((t0 + dur) * SR));
  for (let i = a; i < b; i++) x[i] += amp * Math.exp(-(i - a) / SR / tau) * rand();
};
// 칼림바: 기본음 + 튕길 때 아주 높은 울림(비조화 배음)
const kalimba = (x, f, t0, loud = 1) => {
  sine(x, f, 0.25 * loud, t0, 0.5, 1.2);
  sine(x, f * 5.9, 0.6 * loud, t0, 0.05, 0.3);
  sine(x, f * 16.5, 0.3 * loud, t0, 0.02, 0.1);
};
// 페이지와 같은 거르개: 180Hz 아래를 깎는 고역 통과 필터 2단 (Web Audio BiquadFilter와 같은 식)
function highpass(input, f0 = 180, q = Math.SQRT1_2) {
  const w = 2 * Math.PI * f0 / SR, al = Math.sin(w) / (2 * q), cw = Math.cos(w);
  const a0 = 1 + al, b0 = (1 + cw) / 2 / a0, b1 = -(1 + cw) / a0, b2 = b0, a1 = -2 * cw / a0, a2 = (1 - al) / a0;
  const y = new Float32Array(input.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const v = b0 * input[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = input[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

function run(raw) {
  const x = highpass(highpass(raw));
  const tr = createPitchTracker();
  const out = [];
  const hop = Math.round(TICK * SR);
  for (let end = WIN; end <= x.length; end += hop) {
    const r = tr.step(x.subarray(end - WIN, end), SR);
    // 페이지와 똑같이: rewrite면 같은 음의 앞부분을 다시 그림
    if (r.rewrite) for (const o of out) if (o.note === r.note) o.val = r.val;
    out.push({ t: end / SR, ...r });
  }
  return out;
}

// 음마다: 잡혔는지, 틀린 값 수, 이어 그린 길이(초)
function score(out, notes, spacing) {
  return notes.map(([f, t0]) => {
    const win = out.filter(o => o.t >= t0 && o.t < t0 + spacing);
    const vals = win.filter(o => o.val != null);
    const wrong = vals.filter(o => Math.abs(o.val / f - 1) > 0.06).length;
    const right = vals.length - wrong;
    const bandOk = vals.every(o => (o.val >= SPLIT) === (f >= SPLIT));
    return { f, right, wrong, len: +(right * TICK).toFixed(2), bandOk };
  });
}

const results = [];
function check(name, ok, detail) { results.push({ name, ok, detail }); }

// 1) 칼림바 음계 (보통 크기)
{
  const kal = [262, 294, 330, 349, 392, 440, 494, 523, 587, 659, 784, 880, 1047, 1175, 1319];
  const sp = 0.8;
  const xk = render(kal.length * sp + 0.5, x => { noise(x, 0.002); kal.forEach((f, k) => kalimba(x, f, 0.2 + k * sp)); });
  for (const [name, x, notes] of [['칼림바 음계', xk, kal]]) {
    const s = score(run(x), notes.map((f, k) => [f, 0.2 + k * sp]), sp);
    const bad = s.filter(r => r.right === 0 || r.wrong > 0 || !r.bandOk);
    check(name, bad.length === 0, bad.length ? bad : 'all ' + s.length + ' notes OK');
  }
}

// 2) 배경 웅웅거림(100Hz) 속 칼림바: 맨 아래로 떨어지면 안 됨 (위아래 기둥 문제)
{
  const notes = [1047, 1047, 1047, 1047, 1047, 1047];
  const sp = 0.45;
  const x = render(notes.length * sp + 0.6, x => { hum(x, 100, 0.03); hum(x, 200, 0.012); noise(x, 0.002); notes.forEach((f, k) => kalimba(x, f, 0.2 + k * sp)); });
  const out = run(x);
  const low = out.filter(o => o.val != null && o.val < 200).length;
  let swaps = 0, prev = null;
  for (const o of out) if (o.val != null) { const hi = o.val >= SPLIT; if (prev !== null && hi !== prev) swaps++; prev = hi; }
  check('웅웅거림 속 칼림바', low === 0 && swaps === 0, { lowReadings: low, upDownSwaps: swaps });
}

// 3) 책상 '퉁' 하는 낮은 소리(90Hz)가 섞인 칼림바
{
  const notes = [440, 523, 440, 523];
  const sp = 0.7;
  const x = render(notes.length * sp + 0.5, x => {
    noise(x, 0.002);
    notes.forEach((f, k) => { const t = 0.2 + k * sp; kalimba(x, f, t); sine(x, 90, 0.5, t, 0.12, 0.6); });
  });
  const out = run(x);
  const low = out.filter(o => o.val != null && o.val < 200).length;
  const s = score(out, notes.map((f, k) => [f, 0.2 + k * sp]), sp);
  check('퉁 소리 섞인 칼림바', low === 0 && s.every(r => r.right > 0), { lowReadings: low, notes: s.map(r => r.f + ':' + r.right) });
}

// 4) 작게 연주한 칼림바 (멀리 있는 마이크)
{
  const notes = [262, 330, 392, 523, 784, 1047];
  const sp = 1.0;
  const x = render(notes.length * sp + 0.5, x => { noise(x, 0.0008); notes.forEach((f, k) => kalimba(x, f, 0.2 + k * sp, 0.05)); });
  const s = score(run(x), notes.map((f, k) => [f, 0.2 + k * sp]), sp);
  const miss = s.filter(r => r.right === 0).map(r => r.f);
  const short = s.filter(r => r.right > 0 && r.len < 0.4).map(r => r.f + ' (' + r.len + 's)');
  const wrong = s.filter(r => r.wrong > 0).map(r => r.f);
  check('작은 칼림바 소리', !miss.length && !short.length && !wrong.length, { missed: miss, tooShort: short, wrong });
}

// 5) 조용한 교실 잡음만 있을 때는 아무것도 그리면 안 됨
{
  const x = render(3, x => { noise(x, 0.003); hum(x, 100, 0.004); });
  const n = run(x).filter(o => o.val != null).length;
  check('조용한 교실(소리 없음)', n === 0, { readings: n });
}

// 7) 박수·부스럭 소리(음높이 없는 소리)는 그리면 안 됨
{
  const x = render(4, x => { noise(x, 0.002); for (let k = 0; k < 10; k++) noise(x, 0.5, 0.2 + k * 0.35, 0.08, 0.015); });
  const n = run(x).filter(o => o.val != null).length;
  check('박수·부스럭 소리', n === 0, { readings: n });
}

// 8) 어린이가 '아~' 하고 길게 노래 (6초, 살짝 떨림): 끝까지 이어져야 함
{
  const x = render(6.5, x => {
    noise(x, 0.002);
    let ph = 0;
    for (let i = Math.floor(0.2 * SR); i < Math.floor(6.2 * SR); i++) {
      const f = 330 * (1 + 0.01 * Math.sin(2 * Math.PI * 5 * i / SR));
      ph += 2 * Math.PI * f / SR;
      x[i] += 0.1 * Math.sin(ph) + 0.05 * Math.sin(2 * ph) + 0.02 * Math.sin(3 * ph);
    }
  });
  const out = run(x).filter(o => o.t > 0.5 && o.t < 6.1);
  const ok = out.filter(o => o.val != null && Math.abs(o.val / 330 - 1) < 0.06).length;
  check('길게 노래하기', ok / out.length > 0.95, { covered: Math.round(ok / out.length * 100) + '%' });
}

// 9) 웅웅거림이 큰 교실에서 작게 친 칼림바 (브라우저에서 놓친 경우)
{
  const notes = [262, 392, 440, 523, 262, 1047];
  const sp = 0.8;
  const x = render(notes.length * sp + 0.5, x => {
    hum(x, 100, 0.03); noise(x, 0.001);
    notes.forEach((f, k) => { const t = 0.3 + k * sp; sine(x, f, 0.06, t, 0.4, 0.78); sine(x, f * 5.9, 0.12, t, 0.05, 0.3); });
  });
  const out = run(x);
  const s = score(out, notes.map((f, k) => [f, 0.3 + k * sp]), sp);
  const low = out.filter(o => o.val != null && o.val < 200).length;
  check('큰 웅웅거림 + 작은 칼림바', low === 0 && s.every(r => r.right > 0 && r.wrong === 0), { lowReadings: low, notes: s.map(r => r.f + ':' + r.right + '/' + r.wrong) });
}

// 목소리 흉내: 기본음 + 배음 여러 개, 음높이가 살짝 오르내림, 음절마다 끊김
function voice(x, f0, t0, dur, amp = 0.08) {
  let ph = 0;
  const a = Math.floor(t0 * SR), b = Math.floor((t0 + dur) * SR);
  for (let i = a; i < b; i++) {
    const t = (i - a) / SR;
    const f = f0 * (1 + 0.06 * Math.sin(2 * Math.PI * 0.7 * t)) * (1 + 0.01 * Math.sin(2 * Math.PI * 5 * t));
    ph += 2 * Math.PI * f / SR;
    const env = Math.min(1, t / 0.03, (dur - t) / 0.03) * (0.6 + 0.4 * Math.abs(Math.sin(2 * Math.PI * 2.5 * t)));
    let v = 0;
    for (let h = 1; h <= 10; h++) v += Math.sin(h * ph) / h;
    x[i] += amp * env * v;
  }
}

// 10) 목소리: 어른 남자(120Hz)·어른 여자(210Hz)·어린이(300Hz)가 '아~' 하고 말하기
for (const [name, f0] of [['어른 남자 목소리', 120], ['어른 여자 목소리', 210], ['어린이 목소리', 300]]) {
  const x = render(3.6, x => { noise(x, 0.002); voice(x, f0, 0.3, 3); });
  const out = run(x).filter(o => o.t > 0.5 && o.t < 3.2);
  const vals = out.filter(o => o.val != null);
  const right = vals.filter(o => Math.abs(o.val / f0 - 1) < 0.1).length;
  check(name, right / out.length > 0.7 && right === vals.length,
    { covered: Math.round(right / out.length * 100) + '%', wrong: vals.filter(o => Math.abs(o.val / f0 - 1) >= 0.1).map(o => Math.round(o.val)).slice(0, 6) });
}

// 11) 높은 칼림바 음 + 교실 잡음: 낮은 소리로 떨어지면 안 됨 (1/6 높이로 잘못 읽는 문제)
{
  let low = 0, total = 0;
  for (const f of [1047, 1175, 1319, 1568]) for (const nz of [0.002, 0.005, 0.01]) for (const p2 of [0, 0.5]) {
    const x = render(4.2, x => {
      for (let k = 0; k < 4; k++) {
        const t = 0.2 + k;
        sine(x, f, 0.06, t, 0.35, 0.9);
        if (p2) sine(x, f * 2.013, p2 * 0.06, t, 0.35, 0.9);
        sine(x, f * 5.9, 0.1, t, 0.04, 0.3);
      }
      noise(x, nz);
    });
    for (const o of run(x)) if (o.val != null) { total++; if (o.val < SPLIT) low++; }
  }
  check('높은 칼림바 + 잡음', low === 0, { lowReadings: low, of: total });
}

// 12) '시작'을 누를 때 이미 소리를 내고 있던 경우 (앞에 조용한 순간이 없음)
for (const f0 of [120, 210, 300]) {
  const x = render(3, x => voice(x, f0, 0, 3));
  const out = run(x).filter(o => o.t > 0.3);
  const right = out.filter(o => o.val != null && Math.abs(o.val / f0 - 1) < 0.1).length;
  check('처음부터 소리 ' + f0 + 'Hz', right / out.length > 0.7, { covered: Math.round(right / out.length * 100) + '%' });
}

// 13) 쉬지 않고 20초 동안 말하기·노래하기: 끝까지 잡혀야 함
{
  const x = render(21, x => { noise(x, 0.002); voice(x, 220, 0.5, 20); });
  const out = run(x).filter(o => o.t > 15 && o.t < 20.3);
  const right = out.filter(o => o.val != null && Math.abs(o.val / 220 - 1) < 0.1).length;
  check('20초 동안 계속 목소리', right / out.length > 0.7, { coveredLast5s: Math.round(right / out.length * 100) + '%' });
}

let fail = 0;
for (const r of results) {
  console.log((r.ok ? 'PASS' : 'FAIL') + '  ' + r.name + '  ' + JSON.stringify(r.detail));
  if (!r.ok) fail++;
}
process.exit(fail ? 1 : 0);
