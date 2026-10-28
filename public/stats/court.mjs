// Court geometry for camera stats. Units are metres. x runs across the court from the
// near-left corner; y runs away from the camera, from the near baseline to the far one.
// Shared by the browser (live tracking) and the server (validating saved stats).

const seg = (x1, y1, x2, y2) => [[x1, y1], [x2, y2]];
const outline = (W, L) => [seg(0, 0, W, 0), seg(W, 0, W, L), seg(W, L, 0, L), seg(0, L, 0, 0)];

function badmintonLines(W, L, singles) {
  const mid = L / 2;
  const s = 1.98; // short service line, from the net
  const lines = [...outline(W, L), seg(0, mid, W, mid), seg(0, mid - s, W, mid - s), seg(0, mid + s, W, mid + s),
    seg(W / 2, 0, W / 2, mid - s), seg(W / 2, mid + s, W / 2, L)];
  if (!singles) {
    lines.push(seg(0.46, 0, 0.46, L), seg(W - 0.46, 0, W - 0.46, L), seg(0, 0.76, W, 0.76), seg(0, L - 0.76, W, L - 0.76));
  }
  return lines;
}

function tennisLines(W, L, singles) {
  const mid = L / 2;
  const inset = singles ? 0 : 1.37;
  return [...outline(W, L), seg(0, mid, W, mid), seg(inset, mid - 6.4, W - inset, mid - 6.4), seg(inset, mid + 6.4, W - inset, mid + 6.4),
    seg(W / 2, mid - 6.4, W / 2, mid + 6.4),
    ...(singles ? [] : [seg(inset, 0, inset, L), seg(W - inset, 0, W - inset, L)])];
}

export const COURTS = {
  'badminton-doubles': { name: 'Badminton — doubles court', sport: 'badminton', width: 6.1, length: 13.4, maxPlayers: 4, swings: true, lines: () => badmintonLines(6.1, 13.4, false) },
  'badminton-singles': { name: 'Badminton — singles lines', sport: 'badminton', width: 5.18, length: 13.4, maxPlayers: 2, swings: true, lines: () => badmintonLines(5.18, 13.4, true) },
  'tennis-doubles': { name: 'Lawn tennis — doubles court', sport: 'lawn-tennis', width: 10.97, length: 23.77, maxPlayers: 4, swings: true, lines: () => tennisLines(10.97, 23.77, false) },
  'tennis-singles': { name: 'Lawn tennis — singles lines', sport: 'lawn-tennis', width: 8.23, length: 23.77, maxPlayers: 2, swings: true, lines: () => tennisLines(8.23, 23.77, true) },
  volleyball: { name: 'Volleyball', sport: 'volleyball', width: 9, length: 18, maxPlayers: 12, swings: false, lines: () => [...outline(9, 18), seg(0, 9, 9, 9), seg(0, 6, 9, 6), seg(0, 12, 9, 12)] },
  basketball: { name: 'Basketball — full court', sport: 'basketball', width: 15, length: 28, maxPlayers: 10, swings: false, lines: () => [...outline(15, 28), seg(0, 14, 15, 14)] },
};

// The four corners, in the order the user taps them.
export const CORNER_NAMES = ['near-left', 'near-right', 'far-right', 'far-left'];
export const cornersOf = (court) => [[0, 0], [court.width, 0], [court.width, court.length], [0, court.length]];

// Heat-map grid: 1 m cells.
export const heatSize = (court) => ({ cols: Math.ceil(court.width), rows: Math.ceil(court.length) });

// Solves an 8x8 linear system by Gaussian elimination with partial pivoting.
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-10) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

// Homography H (row-major 3x3) mapping four src points onto four dst points.
export function homography(src, dst) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solve(A, b);
  return h && [...h, 1];
}

export function apply(H, [x, y]) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

// Taps must form a convex quadrilateral going round in one direction.
function isConvex(pts) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [a, b, c] = [pts[i], pts[(i + 1) % 4], pts[(i + 2) % 4]];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) < 1e-6) return false;
    if (sign === 0) sign = Math.sign(cross);
    else if (Math.sign(cross) !== sign) return false;
  }
  return true;
}

// From the four tapped image points to a calibration, or null if the taps can't be a court.
export function calibrate(court, imagePoints) {
  if (!imagePoints || imagePoints.length !== 4 || !isConvex(imagePoints)) return null;
  const corners = cornersOf(court);
  const toImage = homography(corners, imagePoints);
  const toCourt = homography(imagePoints, corners);
  if (!toImage || !toCourt) return null;
  return { court, toImage, toCourt, imagePoints };
}

export function inside(court, [x, y], margin = 0) {
  return x >= -margin && x <= court.width + margin && y >= -margin && y <= court.length + margin;
}
