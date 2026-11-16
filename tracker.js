// 마이크 소리 조각을 받아 지금 음높이(Hz)를 알려 주는 측정기.
// step()은 { val, fresh } 를 돌려줌. val: 그래프에 그릴 높이(없으면 null), fresh: 새로 확정된 높이인지.
function createPitchTracker() {
  // 80Hz까지 찾음 (어른 남자 목소리). 책상 '퉁'·웅웅거림은 페이지에서 180Hz 아래를 미리 걸러내므로
  // 거의 사라지고, 배음이 많은 목소리는 걸러낸 뒤에도 원래 높이가 그대로 남음.
  const FLOOR = 80, CEIL = 2600;
  const ATTACK = 10;   // 음이 시작된 뒤 이 프레임 수(20ms × 10 = 0.2초) 동안은 '가장 많이 나온 높이'로 정함

  // 교실 바탕 소리 크기: 최근 약 8초 중 가장 조용했던 순간.
  // 계속 말하거나 처음부터 소리가 나도 목소리를 '바탕 소리'로 착각하지 않도록 위쪽을 막아 둠.
  const ROOM_LEN = 400, ROOM_MIN = 0.0015, ROOM_MAX = 0.012;
  const roomHist = new Float32Array(ROOM_LEN).fill(ROOM_MAX);
  let roomPos = 0;

  let lastRms = 0, holdOff = 0, sinceOnset = 99;
  let note = 0;          // 음 번호 (새로 칠 때마다 1씩)
  let groups = [];       // 시작 0.2초 동안 나온 높이 묶음 { f, n }
  let noteVal = null;    // 지금 음의 높이
  let shown = null;      // 화면 숫자로 마지막에 알린 높이
  let prevF = -1;
  let pending = false;   // 시작 부분 높이를 아직 못 정함
  let jump = 0;

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
    // 작은 소리라 잡음이 섞이면 0.15 아래로 안 내려갈 수 있음.
    // 가장 깊은 골만 고르면 2배·6배 긴 주기(= 1/2, 1/6 높이)를 잡을 수 있으므로,
    // 가장 깊은 골과 비슷하게 깊은 골 중 '가장 짧은 주기'를 고름.
    if (tau < 0) {
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

  const close = (x, y, tol = 0.06) => Math.abs(x / y - 1) < tol;

  function endNote() {
    note++; groups = []; noteVal = null; prevF = -1; sinceOnset = 99; pending = false; jump = 0;
  }

  return {
    // 돌려주는 값
    //  val: 그래프에 그릴 높이 (없으면 null)
    //  fresh: 화면 숫자를 바꿀 때 true
    //  note: 이 프레임이 속한 음 번호 (시작 0.2초 안일 때만, 아니면 -1)
    //  rewrite: true면 같은 note 번호로 그렸던 앞부분을 val로 다시 그림
    step(buf, sr) {
      let rms = 0;
      for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
      rms = Math.sqrt(rms / buf.length);

      roomHist[roomPos] = rms; roomPos = (roomPos + 1) % ROOM_LEN;
      let room = ROOM_MAX;
      for (let i = 0; i < ROOM_LEN; i++) if (roomHist[i] < room) room = roomHist[i];
      room = Math.max(ROOM_MIN, room);
      const loudEnough = Math.max(0.002, room * 1.6);    // 악기 소리로 볼 크기
      const stillRinging = Math.max(0.001, room * 1.25); // 울림이 남아 있다고 볼 크기

      // 새로 치거나 튕긴 순간: 소리가 갑자기 커짐. 튕기는 잡음이 있으니 한 프레임 건너뜀
      if (rms > loudEnough && rms > lastRms * 1.8 && sinceOnset > 3) {
        endNote(); sinceOnset = 0; holdOff = 1;
      }
      lastRms = rms;

      let f = -1;
      if (holdOff > 0) holdOff--;
      else if (rms >= loudEnough) f = detect(buf, sr);
      if (!(f >= FLOOR && f <= CEIL)) f = -1;

      // 같은 음이 울리는 중에 그 음의 1/2 … 1/8 높이가 나오면 잘못 읽은 것: 원래 음으로 봄
      if (f > 0 && noteVal != null) {
        for (let n = 2; n <= 8; n++) if (close(f * n, noteVal, 0.04)) { f = noteVal; break; }
      }

      // 바로 앞 프레임과 같은 높이가 나와야 믿음 (2번 연속)
      const ok = f > 0 && prevF > 0 && close(f, prevF);
      prevF = f;

      const inAttack = sinceOnset < ATTACK;
      let val = null, fresh = false, rewrite = false, noteOut = inAttack ? note : -1;
      const best = () => groups.reduce((a, b) => (b.n > a.n ? b : a));
      // 시작 부분의 높이를 정하고, 그동안 비워 둔 앞부분을 그 높이로 채움
      const settle = v => { noteVal = v; pending = false; val = v; rewrite = true; noteOut = note; };

      if (inAttack) {
        // 시작 0.2초: 그리지 않고 높이만 모아 둠 (튕기는 소리에 섞인 높은 울림이 튀어 보이지 않게)
        pending = true;
        if (ok) {
          const g = groups.find(g => close(f, g.f));
          if (g) { g.f = (g.f * g.n + f) / (g.n + 1); g.n++; } else groups.push({ f, n: 1 });
        }
      } else if (pending && ok) {
        // 시작 뒤 처음으로 자리 잡은 높이 = 이 음의 높이
        settle(f);
      } else if (pending && groups.length && sinceOnset >= ATTACK + 4) {
        settle(best().f);   // 자리 잡은 높이가 안 나오면 시작 부분에서 가장 많이 나온 높이
      } else if (ok) {
        // 그 뒤로는 지금 높이 그대로 (노래하며 오르내리는 목소리).
        // 다만 갑자기 6% 넘게 바뀌면 3번 연속 나와야 믿음 (잦아드는 울림에 잡음이 섞여 흔들리는 것 막기)
        // 거의 사라져 가는 울림(작은 소리)에서는 높이를 바꾸지 않고 그대로 이어 그림
        if (noteVal != null && rms < loudEnough * 2) { /* 그대로 */ }
        else if (noteVal == null || close(f, noteVal)) { jump = 0; noteVal = f; val = f; }
        else if (++jump >= 2) { jump = 0; noteVal = f; val = f; }
      }

      if (val == null && noteVal != null && !pending && rms > stillRinging) val = noteVal;  // 울림이 남아 있으면 이어서

      if (rms <= stillRinging && (noteVal != null || pending)) {
        // 소리가 끝남: 짧게 끝난 음(붐웨커)이면 시작 부분에서 가장 많이 나온 높이로 채움
        if (pending && groups.length) settle(best().f);
        endNote();
      }

      if (val != null && (shown == null || !close(shown, val, 0.005))) fresh = true;
      if (fresh) shown = val;
      if (sinceOnset < 99) sinceOnset++;
      return { val, fresh, note: noteOut, rewrite };
    }
  };
}

if (typeof module !== 'undefined') module.exports = { createPitchTracker };
