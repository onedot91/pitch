// 마이크 소리 조각을 받아 지금 음높이(Hz)를 알려 주는 측정기.
// step()은 { val, fresh } 를 돌려줌. val: 그래프에 그릴 높이(없으면 null), fresh: 새로 확정된 높이인지.
function createPitchTracker() {
  // 180Hz보다 낮은 소리(책상 '퉁', 전기 웅웅거림, 바람 소리)는 악기가 아니므로 무시.
  // 칼림바·붐웨커 가장 낮은 도가 262Hz.
  const FLOOR = 180, CEIL = 2600;
  let recent = [], lastRms = 0, holdOff = 0, held = null;
  let room = 0;   // 교실 바탕 소리 크기 (조용할 때 기준)

  // YIN 방식 음높이 찾기
  function detect(x, sr) {
    const W = x.length >> 1;
    const tMin = Math.max(2, Math.floor(sr / CEIL));
    const tMax = Math.min(W - 1, Math.ceil(sr / (FLOOR * 0.9)));
    const d = new Float32Array(tMax + 2);
    for (let t = 1; t <= tMax + 1; t++) {
      let s = 0;
      for (let i = 0; i < W; i++) { const v = x[i] - x[i + t]; s += v * v; }
      d[t] = s;
    }
    let sum = 0; const c = new Float32Array(tMax + 2); c[0] = 1;
    for (let t = 1; t <= tMax + 1; t++) { sum += d[t]; c[t] = sum ? d[t] * t / sum : 1; }

    let tau = -1;
    for (let t = tMin; t <= tMax; t++) {
      if (c[t] < 0.15) {
        while (t + 1 <= tMax && c[t + 1] < c[t]) t++;
        tau = t; break;
      }
    }
    // 작은 소리라 잡음이 섞이면 0.15 아래로 안 내려갈 수 있음: 가장 깊은 골이 충분히 깊으면 사용
    if (tau < 0) {
      let best = tMin;
      for (let t = tMin; t <= tMax; t++) if (c[t] < c[best]) best = t;
      if (c[best] < 0.3) tau = best;
    }
    if (tau < 0 || tau >= tMax) return -1;
    const a = c[tau - 1], b = c[tau], e = c[tau + 1];
    const den = a + e - 2 * b;
    const shift = den ? (a - e) / (2 * den) : 0;
    return sr / (tau + shift);
  }

  const median = arr => [...arr].sort((a, b) => a - b)[arr.length >> 1];

  return {
    step(buf, sr) {
      let rms = 0;
      for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
      rms = Math.sqrt(rms / buf.length);

      // 교실 바탕 소리: 조용해지면 바로 따라 내려가고, 시끄러우면 아주 천천히 올라감
      room = room === 0 || rms < room ? rms : room * 1.001;
      const loudEnough = Math.max(0.002, room * 2.5);   // 악기 소리로 볼 크기
      const stillRinging = Math.max(0.001, room * 1.6); // 울림이 남아 있다고 볼 크기

      // 악기를 튕기는 순간(소리가 갑자기 커질 때)에는 높은 잡음이 섞이므로 잠깐 건너뜀
      if (rms > loudEnough && rms > lastRms * 1.8) { holdOff = 2; recent = []; held = null; }
      lastRms = rms;

      let f = -1;
      if (holdOff > 0) holdOff--;
      else if (rms >= loudEnough) f = detect(buf, sr);

      // 같은 높이가 3번 연속 나와야 믿음
      let val = null, fresh = false;
      if (f >= FLOOR && f <= CEIL) {
        recent.push(f); if (recent.length > 3) recent.shift();
        if (recent.length === 3 && recent.every(x => Math.abs(x / f - 1) < 0.06)) {
          val = held = median(recent); fresh = true;
        }
      } else {
        recent = [];
      }
      // 울림이 남아 있는 동안은 같은 높이로 이어서 그림
      if (val == null && held != null) {
        if (rms > stillRinging && holdOff === 0) val = held;
        else if (rms <= stillRinging) held = null;
      }
      return { val, fresh };
    }
  };
}

if (typeof module !== 'undefined') module.exports = { createPitchTracker };
