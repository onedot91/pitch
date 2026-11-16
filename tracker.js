// 마이크 소리 조각을 받아 지금 음높이(Hz)를 알려 주는 측정기.
// step()은 { val, fresh } 를 돌려줌. val: 그래프에 그릴 높이(없으면 null), fresh: 새로 확정된 높이인지.
function createPitchTracker() {
  // 80Hz까지 찾음 (어른 남자 목소리). 책상 '퉁'·웅웅거림은 페이지에서 180Hz 아래를 미리 걸러내므로
  // 거의 사라지고, 배음이 많은 목소리는 걸러낸 뒤에도 원래 높이가 그대로 남음.
  const FLOOR = 80, CEIL = 2600;
  let recent = [], smooth = [], lastRms = 0, holdOff = 0, held = null;
  // 교실 바탕 소리 크기 (시끄러운 교실 대비): 최근 약 6초 동안 배운 소리 크기 중 아래쪽 20% 지점.
  // 또렷한 높이를 따라가는 중(내 칼림바·'아~')에는 배우지 않으므로, 친구들 떠드는 소리만 바탕으로 배움.
  // 바탕 소리보다 1.6배 이상 커야 그리므로, 크롬북 가까이에서 내는 내 소리만 잡힘.
  const ROOM_LEN = 200, ROOM_MIN = 0.0015, ROOM_MAX = 0.03;
  const roomHist = new Float32Array(ROOM_LEN).fill(ROOM_MAX);
  let roomPos = 0, roomCount = 0;

  // YIN 방식 음높이 찾기
  function detect(x, sr, quiet) {
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
      if (c[t] < (quiet ? 0.25 : 0.15)) {
        while (t + 1 <= tMax && c[t + 1] < c[t]) t++;
        tau = t; break;
      }
    }
    // 작은 소리라 잡음이 섞이면 0.15 아래로 안 내려갈 수 있음.
    // 가장 깊은 골만 고르면 2배·6배 긴 주기(= 1/2, 1/6 높이)를 잡을 수 있으므로,
    // 가장 깊은 골과 비슷하게 깊은 골 중 '가장 짧은 주기'를 고름.
    if (tau < 0 && !quiet) {   // 작은 소리에는 이 방법을 쓰지 않음
      let gmin = 1;
      for (let t = tMin; t <= tMax; t++) if (c[t] < gmin) gmin = c[t];
      if (gmin < 0.3) {
        for (let t = tMin; t <= tMax; t++) {
          if (c[t] <= gmin + 0.08 && c[t] <= c[t - 1] && c[t] <= c[t + 1]) { tau = t; break; }
        }
      }
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

      // 또렷한 높이를 따라가는 중이 아닐 때만 '교실 소리'로 배움 (내 '아~' 소리나 칼림바는 배우지 않음)
      if (held == null) { roomHist[roomPos] = rms; roomPos = (roomPos + 1) % ROOM_LEN; if (roomCount < ROOM_LEN) roomCount++; }
      let room = ROOM_MIN;
      if (roomCount) {
        const sorted = Array.from(roomHist.subarray(0, roomCount)).sort((a, b) => a - b);
        room = Math.min(ROOM_MAX, Math.max(ROOM_MIN, sorted[Math.floor(roomCount * 0.2)]));
      }
      // 민감도: 바탕 소리보다 1.6배 이상 크면 악기·목소리로 봄.
      // 다만 2.5배가 안 되는 작은 소리는 '주기가 아주 뚜렷할 때만' 믿음 (작은 낮은 도는 잡고, 잡음은 거름)
      const loudEnough = Math.max(0.002, room * 1.6);
      const stillRinging = Math.max(0.0015, room * 1.5); // 울림이 남아 있다고 볼 크기

      // 악기를 튕기는 순간(소리가 갑자기 커질 때)에는 높은 잡음이 섞이므로 잠깐 건너뜀
      if (rms > loudEnough && rms > lastRms * 1.8) { holdOff = 2; recent = []; held = null; smooth = []; }
      lastRms = rms;

      let f = -1;
      if (holdOff > 0) holdOff--;
      else if (rms >= loudEnough) f = detect(buf, sr, rms < room * 2.5);

      // 같은 음이 울리는 중에 그 음의 1/2, 1/3 … 1/8 높이가 나오면 잘못 읽은 것: 원래 음으로 봄
      if (f > 0 && held != null) {
        for (let n = 2; n <= 8; n++) if (Math.abs((f * n) / held - 1) < 0.04) { f = held; break; }
      }

      // 거의 사라져 가는 울림에서는 높이를 새로 재지 않음 (끝부분이 흔들리지 않게)
      if (held != null && rms < loudEnough * 1.5) f = -1;

      // 같은 높이가 3번 연속 나와야 믿고, 화면에는 최근 5번의 가운데 값을 보여 줌 (덜 흔들리게)
      let val = null, fresh = false;
      if (f >= FLOOR && f <= CEIL) {
        recent.push(f); if (recent.length > 3) recent.shift();
        if (recent.length === 3 && recent.every(x => Math.abs(x / f - 1) < 0.06)) {
          smooth.push(median(recent)); if (smooth.length > 5) smooth.shift();
          val = held = median(smooth); fresh = true;
        }
      } else {
        recent = [];
      }
      // 울림이 남아 있는 동안은 같은 높이로 이어서 그림
      if (val == null && held != null) {
        if (rms > stillRinging && holdOff === 0) val = held;
        else if (rms <= stillRinging) { held = null; smooth = []; }
      }
      return { val, fresh };
    }
  };
}

if (typeof module !== 'undefined') module.exports = { createPitchTracker };
