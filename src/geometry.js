'use strict';

// 地理围栏点在多边形内判定。
//
// 设计要点：
//   1. 所有十进制坐标先统一到公共标度 10^K（K 为全部坐标中小数位数的最大值），
//      之后交点、叉积、在线判定全部使用 BigInt 整数精确完成，保证落在顶点或
//      边上的点稳定返回 BOUNDARY，且不受浮点误差影响。
//   2. 经度约定为 [-180, 180)。逐边按“相邻经度间的较短方向”连接：直接经度差
//      绝对值大于 180° 时对后续顶点整体平移 ±360°，把环展开到连续经度框架中
//      （恰差 180° 方向不唯一，拒绝）。若展开后闭合边需连到起点的 ±360° 周期
//      副本（环整体绕地球一周），因内外不唯一且正反向裁决互补，同样拒绝。
//   3. 判定点生成 q-360°、q、q+360° 三个副本，任一副本落在展开环内即 INSIDE；
//      落在任意一条边（含任意周期副本）上即 BOUNDARY。
//   4. 环方向反转只改变有向面积符号，不影响边界判定与奇偶穿越，裁决不变。

const MIN_VERTICES = 3;
const MAX_VERTICES = 128;
const MIN_POINTS = 1;
const MAX_POINTS = 500;
// 超过该小数位数视为不合理输入（也防止超大 BigInt 造成的资源消耗）。
const MAX_FRACTION_DIGITS = 40;

class GeofenceError extends Error {
  // code: 机器可读错误码；where: 例如 "polygon[2]" / "points[5]" / "polygon[2].lat"
  constructor(code, message, where = null) {
    super(message);
    this.name = 'GeofenceError';
    this.code = code;
    this.where = where;
  }
}

function fail(code, message, where = null) {
  throw new GeofenceError(code, message, where);
}

const NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

// 把一个十进制标量解析为 { int: bigint（带符号有效整数）, frac: 小数位数 }
function parseScalar(raw, where) {
  let s;
  if (typeof raw === 'string') {
    s = raw.trim();
  } else if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) {
      fail('INVALID_COORDINATE', `${where}: 坐标必须为有限十进制数`, where);
    }
    s = String(raw); // 最短往返表示，恢复其十进制写法
  } else {
    fail('INVALID_COORDINATE', `${where}: 坐标必须为十进制数（字符串或数字）`, where);
  }
  if (!NUMBER_RE.test(s)) {
    fail('INVALID_COORDINATE', `${where}: "${raw}" 不是有限十进制数`, where);
  }

  const m = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(s);
  const neg = m[1] === '-';
  const intPart = m[2] || '0';
  const fracPart = m[3] !== undefined ? m[3] : (m[4] || '');
  const exp = m[5] !== undefined ? parseInt(m[5], 10) : 0;

  let digits = intPart + fracPart;
  let frac = fracPart.length - exp;
  if (frac < 0) {
    digits += '0'.repeat(-frac);
    frac = 0;
  }
  if (frac > MAX_FRACTION_DIGITS) {
    fail(
      'INVALID_COORDINATE',
      `${where}: 小数位数超过 ${MAX_FRACTION_DIGITS} 位，请降低坐标精度`,
      where
    );
  }
  const int = BigInt(digits) * (neg ? -1n : 1n);
  return { int, frac };
}

function parseCoord(raw, index, kind) {
  // kind: 'polygon'（顶点）或 'points'（点位）
  const base = `${kind}[${index}]`;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('INVALID_COORDINATE', `${base}: 坐标必须是包含 lat/lon 的对象`, base);
  }
  if (!('lat' in raw) || !('lon' in raw)) {
    fail('INVALID_COORDINATE', `${base}: 坐标必须同时包含 lat 与 lon`, base);
  }
  const lat = parseScalar(raw.lat, `${base}.lat`);
  const lon = parseScalar(raw.lon, `${base}.lon`);
  return { lat, lon };
}

// 统一缩放到 10^K 的整数坐标，并做范围校验（经、纬度分别按各自小数位缩放）
function scaleCoord(c, S, K, index, kind) {
  const base = `${kind}[${index}]`;
  const y = c.lat.int * 10n ** BigInt(K - c.lat.frac);
  const x = c.lon.int * 10n ** BigInt(K - c.lon.frac);
  if (y <= -90n * S || y >= 90n * S) {
    fail('LAT_OUT_OF_RANGE', `${base}.lat: 纬度必须位于开区间 (-90, 90)`, `${base}.lat`);
  }
  if (x < -180n * S || x >= 180n * S) {
    fail('LON_OUT_OF_RANGE', `${base}.lon: 经度必须位于左闭右开区间 [-180, 180)`, `${base}.lon`);
  }
  return { x, y };
}

function samePoint(a, b) {
  return a.x === b.x && a.y === b.y;
}

function cross(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function inBox(a, b, p) {
  return p.x >= (a.x < b.x ? a.x : b.x) && p.x <= (a.x > b.x ? a.x : b.x) &&
         p.y >= (a.y < b.y ? a.y : b.y) && p.y <= (a.y > b.y ? a.y : b.y);
}

// 按较短经度方向把环展开为一组边 [{a,b}...]，坐标可能超出 [-180,180) 标度范围。
// 返回 { edges, winding }：winding 为闭合终点相对起点的 360° 周期数。
//   winding = 0：环在柱面上可收缩，存在唯一的“内部”区域；
//   winding ≠ 0：环整体环绕地球一周（如倾斜纬环），两侧都是无界区域，
//                不指定球极便无从区分内外，正向/反向会给出互补结论，故拒绝。
function buildEdges(points, S) {
  const n = points.length;
  const STEP = 360n * S;
  const HALF = 180n * S;

  const coords = points.map((p) => ({ x: p.x, y: p.y }));

  const applyShortest = (ax, bx, i, j) => {
    let d = bx - ax;
    if (d === HALF || d === -HALF) {
      fail(
        'ANTIMERIDIAN_AMBIGUOUS_EDGE',
        `polygon[${i}] -> polygon[${j}]: 经度恰差 180°，较短方向连接不唯一`,
        `polygon[${i}]`
      );
    }
    if (d > HALF) return bx - STEP;
    if (d < -HALF) return bx + STEP;
    return bx;
  };

  // 依次把每个顶点放到相对前一顶点的最短周期上
  for (let i = 0; i < n - 1; i++) {
    coords[i + 1].x = applyShortest(coords[i].x, coords[i + 1].x, i, i + 1);
  }

  // 闭合边：在起点的若干 360° 周期副本中，找到与末点经度差严格小于 180° 的那个
  const lastX = coords[n - 1].x;
  const rawFirstX = points[0].x;
  let endX = null;
  for (let k = -n; k <= n; k++) {
    const cand = rawFirstX + BigInt(k) * STEP;
    const d = cand - lastX;
    if (d === HALF || d === -HALF) {
      fail(
        'ANTIMERIDIAN_AMBIGUOUS_EDGE',
        `polygon[${n - 1}] -> polygon[0]: 经度恰差 180°，较短方向连接不唯一`,
        `polygon[${n - 1}]`
      );
    }
    if (d > -HALF && d < HALF) {
      endX = cand;
      break;
    }
  }
  if (endX === null) {
    fail(
      'NON_CONTRACTIBLE_POLYGON',
      '多边形按较短方向连接后无法在同一经度周期内闭合，请检查顶点顺序',
      'polygon[0]'
    );
  }
  const winding = (endX - rawFirstX) / STEP;

  const edges = [];
  for (let i = 0; i < n; i++) {
    const a = coords[i];
    const b = i === n - 1 ? { x: endX, y: coords[0].y } : coords[i + 1];
    edges.push({ a, b });
  }
  return { edges, winding };
}

// 两倍有向面积
function signedArea2(edges) {
  let sum = 0n;
  for (const e of edges) sum += e.a.x * e.b.y - e.b.x * e.a.y;
  return sum;
}

// 两条不共享端点的边是否相交（含端点落在另一条边内部的 T 接与重叠）
function edgesIntersect(a, b, c, d) {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  if (((d1 > 0n && d2 < 0n) || (d1 < 0n && d2 > 0n)) &&
      ((d3 > 0n && d4 < 0n) || (d3 < 0n && d4 > 0n))) {
    return true;
  }
  if (d1 === 0n && inBox(c, d, a)) return true;
  if (d2 === 0n && inBox(c, d, b)) return true;
  if (d3 === 0n && inBox(a, b, c)) return true;
  if (d4 === 0n && inBox(a, b, d)) return true;
  return false;
}

function validatePolygon(scaled, S) {
  const n = scaled.length; // 数量已由上层校验

  // 相邻重复顶点（含首尾）优先单独报告；定位到序列中后出现的顶点
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (samePoint(scaled[i], scaled[j])) {
      const rep = i === n - 1 ? n - 1 : j;
      const other = i === n - 1 ? 0 : i;
      fail(
        'DUPLICATE_VERTEX',
        `polygon[${rep}] 与 polygon[${other}] 坐标重合，相邻顶点不得重复`,
        `polygon[${rep}]`
      );
    }
  }
  // 非相邻重复顶点，定位到后一个顶点
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (samePoint(scaled[i], scaled[j])) {
        fail(
          'DUPLICATE_VERTEX',
          `polygon[${i}] 与 polygon[${j}] 坐标重合，多边形不得包含重复顶点`,
          `polygon[${j}]`
        );
      }
    }
  }

  const { edges, winding } = buildEdges(scaled, S);

  if (winding !== 0n) {
    fail(
      'NON_CONTRACTIBLE_POLYGON',
      '多边形按较短方向连接后整体环绕地球一周，两侧均为无界区域，无法唯一确定内部；' +
      '请将管制区顶点限定在不绕地球一周的单一区域内（可沿日期变更线拆分为两个围栏）',
      'polygon[0]'
    );
  }

  if (signedArea2(edges) === 0n) {
    fail('ZERO_AREA_POLYGON', '多边形面积为零（顶点共线或退化），必须围成非零面积的区域');
  }

  // 简单多边形检测：
  //  (a) 相邻边除共享端点外不得重合或折返（连续三个共线点时，允许同向经过，
  //      但后一条边的终点落在前一条边内部即为“钉子”式自交/重叠）；
  //  (b) 非相邻边不得相交（含 T 接与重叠）。
  for (let i = 0; i < n; i++) {
    const e = edges[i];
    const f = edges[(i + 1) % n];
    if (cross(e.a, e.b, f.b) === 0n && inBox(e.a, e.b, f.b)) {
      fail(
        'SELF_INTERSECTING_POLYGON',
        `多边形退化：边 polygon[${(i + 1) % n}]->polygon[${(i + 2) % n}] ` +
        `与前一条边在共享顶点之外重合或折返`,
        `polygon[${(i + 1) % n}]`
      );
    }
  }
  // (b) 柱面自交检测：把其中一条边平移 -360°/0/+360° 后再比对，
  //      可抓住展开跨度过大时投影回球面与自身周期副本相交的情形。
  //      相邻边在 k=0 时允许共享端点（已由 (a) 覆盖其余退化），只查 ±1 副本；
  //      非相邻边三个周期都查。
  const STEP = 360n * S;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const adjacent = j === i + 1 || (i === 0 && j === n - 1);
      const shifts = adjacent ? [-1n, 1n] : [-1n, 0n, 1n];
      for (const k of shifts) {
        const e1 = edges[i];
        const e2 = edges[j];
        const c = { x: e2.a.x + k * STEP, y: e2.a.y };
        const d = { x: e2.b.x + k * STEP, y: e2.b.y };
        if (edgesIntersect(e1.a, e1.b, c, d)) {
          fail(
            'SELF_INTERSECTING_POLYGON',
            `多边形自交：边 polygon[${i}]->polygon[${(i + 1) % n}] 与 ` +
            `polygon[${j}]->polygon[${(j + 1) % n}]` +
            (k === 0n ? ' 在非顶点处相交' : ' 在跨越日期变更线的周期副本处相交'),
            `polygon[${i}]`
          );
        }
      }
    }
  }
  return edges;
}

// 点 q 是否落在边 a->b 上
function pointOnEdge(q, a, b) {
  if (cross(a, b, q) !== 0n) return false;
  return inBox(a, b, q);
}

// 从 q 朝 +x 方向的水平射线是否以“穿越”方式经过边 a->b。
// 半开区间规则：y 恰等于下端点计、等于上端点不计，避免顶点被两条边重复计数。
function rayCrosses(q, a, b) {
  if (!((a.y <= q.y && b.y > q.y) || (b.y <= q.y && a.y > q.y))) return false;
  // 交点横坐标 xi = a.x + (b.x - a.x) * (q.y - a.y) / (b.y - a.y)，dy 非 0
  const dy = b.y - a.y;
  const xiNum = a.x * dy + (b.x - a.x) * (q.y - a.y);
  // 严格位于射线起点右侧
  if (dy > 0n) return xiNum > q.x * dy;
  return xiNum < q.x * dy;
}

function classifyPoint(point, edges, S) {
  const STEP = 360n * S;
  const copies = [point.x - STEP, point.x, point.x + STEP];

  // 先判边界（三个经度周期副本都要查，覆盖跨变更线且两端都有边界的区域）
  for (const x of copies) {
    const q = { x, y: point.y };
    for (const e of edges) {
      if (pointOnEdge(q, e.a, e.b)) return 'BOUNDARY';
    }
  }

  // 奇偶填充，任一副本在内即在内
  for (const x of copies) {
    const q = { x, y: point.y };
    let inside = false;
    for (const e of edges) {
      if (rayCrosses(q, e.a, e.b)) inside = !inside;
    }
    if (inside) return 'INSIDE';
  }
  return 'OUTSIDE';
}

// 入参：{ polygon: [{lat,lon}...], points: [{lat,lon}...] }
// 返回：与 points 等长、同序的 ('INSIDE'|'BOUNDARY'|'OUTSIDE') 数组
function classify(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    fail('INVALID_REQUEST', '请求体必须是包含 polygon 与 points 的 JSON 对象');
  }
  const { polygon, points } = body;
  if (!Array.isArray(polygon)) {
    fail('INVALID_POLYGON', 'polygon 必须是顶点数组');
  }
  if (!Array.isArray(points)) {
    fail('INVALID_POINTS', 'points 必须是点位数组');
  }
  if (polygon.length < MIN_VERTICES || polygon.length > MAX_VERTICES) {
    fail(
      'INVALID_POLYGON',
      `多边形顶点数必须在 ${MIN_VERTICES} 至 ${MAX_VERTICES} 之间，当前为 ${polygon.length}`
    );
  }

  const parsedPoly = polygon.map((c, i) => parseCoord(c, i, 'polygon'));

  let K = 0;
  for (const c of parsedPoly) K = Math.max(K, c.lat.frac, c.lon.frac);
  const S = 10n ** BigInt(K);
  // 顶点先按当前标度缩放并完整校验（零面积/自交/恰差 180° 等），
  // 之后再校验点位，保证“非法围栏”结论不被点位数量问题掩盖。
  const scaledPoly = parsedPoly.map((c, i) => scaleCoord(c, S, K, i, 'polygon'));
  const edges = validatePolygon(scaledPoly, S);

  if (points.length < MIN_POINTS || points.length > MAX_POINTS) {
    fail(
      'INVALID_POINTS',
      `待判点数量必须在 ${MIN_POINTS} 至 ${MAX_POINTS} 之间，当前为 ${points.length}`
    );
  }

  const parsedPoints = points.map((c, i) => parseCoord(c, i, 'points'));
  let K2 = K;
  for (const c of parsedPoints) K2 = Math.max(K2, c.lat.frac, c.lon.frac);
  if (K2 !== K) {
    // 点位精度高于顶点：以更大的公共标度重建全部整数坐标
    const S2 = 10n ** BigInt(K2);
    const ring2 = validatePolygon(
      parsedPoly.map((c, i) => scaleCoord(c, S2, K2, i, 'polygon')),
      S2
    );
    const scaledPoints2 = parsedPoints.map((c, i) => scaleCoord(c, S2, K2, i, 'points'));
    return scaledPoints2.map((p) => classifyPoint(p, ring2, S2));
  }

  const scaledPoints = parsedPoints.map((c, i) => scaleCoord(c, S, K, i, 'points'));
  return scaledPoints.map((p) => classifyPoint(p, edges, S));
}

module.exports = {
  classify,
  GeofenceError,
  MIN_VERTICES,
  MAX_VERTICES,
  MIN_POINTS,
  MAX_POINTS,
  MAX_BODY_BYTES: 1024 * 1024,
};
