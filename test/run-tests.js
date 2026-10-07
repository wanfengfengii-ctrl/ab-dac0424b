'use strict';

// 零依赖测试：node test/run-tests.js
const assert = require('node:assert/strict');
const { classify, GeofenceError } = require('../src/geometry');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : err);
  }
}

const P = (lat, lon) => ({ lat: String(lat), lon: String(lon) });

function expectError(body, code, whereMatch) {
  try {
    classify(body);
    assert.fail('应当抛出错误');
  } catch (err) {
    assert.ok(err instanceof GeofenceError, `应为 GeofenceError，实际: ${err}`);
    assert.equal(err.code, code, `错误码应为 ${code}，实际 ${err.code}（${err.message}）`);
    if (whereMatch !== undefined) {
      assert.ok(
        err.where && err.where.includes(whereMatch),
        `错误定位应包含 "${whereMatch}"，实际 "${err.where}"`
      );
    }
  }
}

// ---------- 基础矩形 ----------
const square = [P(0, 0), P(0, 10), P(10, 10), P(10, 0)];

test('矩形：内部 INSIDE', () => {
  assert.deepEqual(classify({ polygon: square, points: [P(5, 5)] }), ['INSIDE']);
});

test('矩形：外部 OUTSIDE', () => {
  assert.deepEqual(
    classify({ polygon: square, points: [P(20, 5), P(-5, 5), P(5, 20), P(5, -5)] }),
    ['OUTSIDE', 'OUTSIDE', 'OUTSIDE', 'OUTSIDE']
  );
});

test('矩形：顶点与边稳定 BOUNDARY', () => {
  const r = classify({
    polygon: square,
    points: [
      P(0, 0), P(0, 10), P(10, 10), P(10, 0), // 四个顶点
      P(5, 0), P(5, 10), P(0, 5), P(10, 5),   // 四条边中点
    ],
  });
  assert.deepEqual(r, Array(8).fill('BOUNDARY'));
});

test('斜边上的有理点稳定 BOUNDARY（无浮点误差）', () => {
  // 边 (0,0)->(3,2)，点 (1.5,1)；边 (0,0)->(1,3)，点 (0.25,0.75)
  const tri = [P(0, 0), P(2, 3), P(3, 1)];
  // (lat=1, lon=1.5) 在 (lat0,lon0)-(lat2,lon3) 上
  assert.deepEqual(classify({ polygon: tri, points: [P(1, 1.5)] }), ['BOUNDARY']);
  const tri2 = [P(0, 0), P(3, 1), P(3, 0)];
  assert.deepEqual(classify({ polygon: tri2, points: [P(0.75, 0.25)] }), ['BOUNDARY']);
});

test('结果顺序与点位顺序一致且数量相等', () => {
  const pts = [P(5, 5), P(50, 50), P(0, 0), P(-50, -50), P(5, 5)];
  assert.deepEqual(
    classify({ polygon: square, points: pts }),
    ['INSIDE', 'OUTSIDE', 'BOUNDARY', 'OUTSIDE', 'INSIDE']
  );
});

test('顶点顺序反转不改变裁决', () => {
  const pts = [
    P(5, 5), P(9.999, 9.999), P(0.001, 0.001), P(-1, 5),
    P(0, 5), P(5, 10), P(20, 20), P(10, 0),
  ];
  const a = classify({ polygon: square, points: pts });
  const b = classify({ polygon: [...square].reverse(), points: pts });
  assert.deepEqual(a, b);
});

// ---------- 跨日期变更线 ----------
// 围栏：纬度 [-10,10]，经度 [170,180) ∪ (-180,-170] 的跨线带
const strip = [P(10, 170), P(10, -170), P(-10, -170), P(-10, 170)];

test('跨变更线围栏：线两侧均 INSIDE', () => {
  assert.deepEqual(
    classify({ polygon: strip, points: [P(0, 179.9999), P(0, -179.9999), P(9, 175), P(-9, -175)] }),
    ['INSIDE', 'INSIDE', 'INSIDE', 'INSIDE']
  );
});

test('跨变更线围栏：远离变更线 OUTSIDE', () => {
  assert.deepEqual(
    classify({ polygon: strip, points: [P(0, 0), P(0, 100), P(0, -100), P(20, 175)] }),
    ['OUTSIDE', 'OUTSIDE', 'OUTSIDE', 'OUTSIDE']
  );
});

test('跨变更线围栏：四条边与顶点 BOUNDARY（线两侧一致）', () => {
  const pts = [
    P(10, 170), P(10, -170), P(-10, -170), P(-10, 170), // 顶点
    P(10, 175), P(10, -175),   // 跨线顶边（短方向过 ±180）
    P(-10, 175), P(-10, -175), // 跨线底边
    P(0, 170), P(0, -170),     // 两侧竖边
  ];
  assert.deepEqual(classify({ polygon: strip, points: pts }), Array(pts.length).fill('BOUNDARY'));
});

test('跨变更线围栏：反转顺序裁决一致', () => {
  const pts = [P(0, 179.9999), P(0, -179.9999), P(0, 0), P(10, 175), P(5, -170)];
  assert.deepEqual(
    classify({ polygon: strip, points: pts }),
    classify({ polygon: [...strip].reverse(), points: pts })
  );
});

// 斜跨变更线的三角形 (lat 5,175) (lat 0,-170) (lat -5,175)
const triCross = [P(5, 175), P(0, -170), P(-5, 175)];

test('斜跨变更线三角形：线东/线西判为同一区域', () => {
  // -179° ≡ 181°，展开三角形在经度 181 处的纬度范围约为 ±3
  assert.deepEqual(
    classify({ polygon: triCross, points: [P(1, -179), P(1, 176), P(4, 175.5)] }),
    ['INSIDE', 'INSIDE', 'INSIDE']
  );
  assert.deepEqual(
    classify({ polygon: triCross, points: [P(4.5, -179), P(0, 0), P(-4.5, 180 - 0.0001)] }),
    ['OUTSIDE', 'OUTSIDE', 'OUTSIDE']
  );
});

// ---------- 非法请求 ----------
test('拒绝：顶点数 <3 或 >128', () => {
  expectError({ polygon: [P(0, 0), P(1, 1)], points: [P(0, 0)] }, 'INVALID_POLYGON');
  const big = Array.from({ length: 129 }, (_, i) => P(0, i % 2 ? 1 : 0.1 + i * 0.01));
  expectError({ polygon: big, points: [P(0, 0)] }, 'INVALID_POLYGON');
});

test('拒绝：点位数量 <1 或 >500', () => {
  expectError({ polygon: square, points: [] }, 'INVALID_POINTS');
  expectError({ polygon: square, points: Array(501).fill(P(0, 0)) }, 'INVALID_POINTS');
});

test('接受边界数量：128 顶点 / 500 点位', () => {
  const poly = Array.from({ length: 128 }, (_, i) => {
    const a = (i / 128) * Math.PI * 2;
    return { lat: (50 + 20 * Math.cos(a)).toFixed(6), lon: (20 * Math.sin(a)).toFixed(6) };
  });
  const r = classify({ polygon: poly, points: Array(500).fill(P(50, 0)) });
  assert.equal(r.length, 500);
  assert.ok(r.every((v) => v === 'INSIDE'));
});

test('拒绝：纬度越界（开区间 ±90）', () => {
  expectError({ polygon: [P(90, 0), P(0, 1), P(-1, 0)], points: [] }, 'LAT_OUT_OF_RANGE', 'polygon[0]');
  expectError({ polygon: [P(-90, 0), P(0, 1), P(1, 0)], points: [] }, 'LAT_OUT_OF_RANGE', 'polygon[0]');
  expectError({ polygon: square, points: [P(89.9999, 5), P(90, 5)] }, 'LAT_OUT_OF_RANGE', 'points[1]');
});

test('拒绝：经度越界（[-180,180) 左闭右开）', () => {
  expectError({ polygon: [P(0, 180), P(1, -179), P(-1, -179)], points: [] }, 'LON_OUT_OF_RANGE', 'polygon[0]');
  expectError({ polygon: [P(0, -180.0001), P(1, -179), P(-1, -179)], points: [] }, 'LON_OUT_OF_RANGE', 'polygon[0]');
  expectError({ polygon: square, points: [P(5, 5), P(5, -180.0001)] }, 'LON_OUT_OF_RANGE', 'points[1]');
});

test('接受经度 -180（左闭）且 180 被拒（右开）', () => {
  const poly = [P(0, -180), P(1, -179), P(-1, -179)];
  assert.deepEqual(classify({ polygon: poly, points: [P(0, -179.5)] }), ['INSIDE']);
});

test('拒绝：非有限十进制坐标', () => {
  expectError({ polygon: [{ lat: 'NaN', lon: 0 }, P(1, 1), P(2, 2)], points: [] }, 'INVALID_COORDINATE', 'polygon[0]');
  expectError({ polygon: square, points: [P(5, 5), { lat: 'Infinity', lon: 0 }] }, 'INVALID_COORDINATE', 'points[1]');
  expectError({ polygon: square, points: [P(5, 5), { lat: -Infinity, lon: 0 }] }, 'INVALID_COORDINATE', 'points[1]');
  expectError({ polygon: square, points: [{ lat: 1, lon: 'abc' }] }, 'INVALID_COORDINATE', 'points[0]');
  expectError({ polygon: square, points: [null] }, 'INVALID_COORDINATE', 'points[0]');
  expectError({ polygon: square, points: [{ lat: 1 }] }, 'INVALID_COORDINATE', 'points[0]');
  // 有限但数值超范围：走专门的越界错误
  expectError({ polygon: square, points: [P(5, 5), { lat: '1e999', lon: 0 }] }, 'LAT_OUT_OF_RANGE', 'points[1]');
});

test('拒绝：相邻/首尾重复顶点', () => {
  expectError(
    { polygon: [P(0, 0), P(0, 0), P(10, 10), P(10, 0)], points: [] },
    'DUPLICATE_VERTEX', 'polygon[1]'
  );
  expectError(
    { polygon: [P(0, 0), P(10, 10), P(10, 0), P(0, 0)], points: [] },
    'DUPLICATE_VERTEX', 'polygon[3]'
  );
  expectError(
    { polygon: [P(0, 0), P(10, 10), P(5, 5)], points: [] },
    'ZERO_AREA_POLYGON'
  );
});

test('拒绝：经度恰差 180° 的边', () => {
  // -90 -> 90 恰差 180
  expectError(
    { polygon: [P(0, -90), P(0, 90), P(10, 90), P(10, -90)], points: [] },
    'ANTIMERIDIAN_AMBIGUOUS_EDGE', 'polygon[0]'
  );
  // 179 -> -1 跨线短方向与长方向恰等长
  expectError(
    { polygon: [P(0, 179), P(0, -1), P(10, -1), P(10, 179)], points: [] },
    'ANTIMERIDIAN_AMBIGUOUS_EDGE', 'polygon[0]'
  );
});

test('拒绝：零面积（共线退化）多边形', () => {
  expectError(
    { polygon: [P(0, 0), P(0, 10), P(0, 20)], points: [] },
    'ZERO_AREA_POLYGON'
  );
  expectError(
    { polygon: [P(0, 0), P(5, 10), P(10, 20)], points: [] },
    'ZERO_AREA_POLYGON'
  );
});

test('拒绝：自交（非零面积）多边形', () => {
  // 边 (10,10)->(5,-5) 与边 (0,0)->(10,0) 在 (约 6.67,0) 处横截，且面积非零
  expectError(
    { polygon: [P(0, 0), P(0, 10), P(10, 10), P(-5, 5), P(10, 0)], points: [] },
    'SELF_INTERSECTING_POLYGON'
  );
});

test('拒绝：按较短方向连接后整体绕地球一周的环', () => {
  // 沿倾斜纬环向东推进，每条边经度差 70°（<180），闭合边只有 20°，
  // 但终点连到起点 +360° 周期副本：环环绕地球一周，内外不唯一。
  const loop = [P(5, -170), P(-5, -100), P(5, -30), P(-5, 40), P(5, 110), P(-5, 170)];
  expectError(
    { polygon: loop, points: [P(0, 0)] },
    'NON_CONTRACTIBLE_POLYGON', 'polygon[0]'
  );
  // 反转顺序同样拒绝（不能因反转而给出互补裁决）
  expectError(
    { polygon: [...loop].reverse(), points: [P(0, 0)] },
    'NON_CONTRACTIBLE_POLYGON'
  );
});

test('拒绝：相邻边折返/重叠（钉子形退化）', () => {
  // (0,0)->(0,10)->(0,5)：第三条顶点落在第一条边内部，相邻边部分重叠
  expectError(
    { polygon: [P(0, 0), P(0, 10), P(0, 5), P(10, 10), P(10, 0)], points: [] },
    'SELF_INTERSECTING_POLYGON'
  );
});

test('错误精确定位到点位序号', () => {
  expectError({ polygon: square, points: [P(5, 5), P(5, 5), P(91, 5)] }, 'LAT_OUT_OF_RANGE', 'points[2]');
});

// ---------- 与浮点参考实现的随机差分测试 ----------
// 参考实现镜像 src/geometry.js 的规则：逐边最短方向展开，闭合边连到最近的
// 360° 周期副本；绕组非 0（绕地球一周）返回 null（实现应拒绝）。
function refBuild(raw) {
  const ring = raw.map(([lat, lon]) => [lat, lon]);
  for (let i = 0; i < ring.length - 1; i++) {
    let d = ring[i + 1][1] - ring[i][1];
    if (Math.abs(d - 180) < 1e-9 || Math.abs(d + 180) < 1e-9) return { ambiguous: true };
    if (d > 180) ring[i + 1][1] -= 360;
    else if (d < -180) ring[i + 1][1] += 360;
  }
  const last = ring[ring.length - 1][1];
  const first0 = raw[0][1];
  let end = null;
  for (let k = -2; k <= 2; k++) {
    const cand = first0 + k * 360;
    const d = cand - last;
    if (Math.abs(Math.abs(d) - 180) < 1e-9) return { ambiguous: true };
    if (Math.abs(d) < 180) {
      end = cand;
      break;
    }
  }
  if (end === null) return { nonContractible: true };
  if (Math.abs(end - first0) > 1e-9) return { nonContractible: true };
  return { ring, end };
}

function refClassify(built, qlat, qlon) {
  const { ring, end } = built;
  for (const shift of [-360, 0, 360]) {
    const x = qlon + shift;
    let inside = false;
    for (let i = 0; i < ring.length; i++) {
      const [ay, ax] = ring[i];
      const isLast = i === ring.length - 1;
      const [by, bx0] = isLast ? [ring[0][0], end] : ring[i + 1];
      const bx = bx0;
      if ((ay <= qlat && by > qlat) || (by <= qlat && ay > qlat)) {
        const xi = ax + ((bx - ax) * (qlat - ay)) / (by - ay);
        if (xi > x) inside = !inside;
      }
    }
    if (inside) return 'INSIDE';
  }
  return 'OUTSIDE';
}

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('随机凸多边形（含跨线）与浮点参考一致，且反转不变', () => {
  const rand = mulberry32(20261007);
  let compared = 0;
  for (let iter = 0; iter < 400; iter++) {
    const n = 3 + Math.floor(rand() * 8);
    const centerLon = -180 + rand() * 360;
    const centerLat = -60 + rand() * 120;
    const radiusLon = 5 + rand() * 100;
    const radiusLat = 5 + rand() * 30;
    const angles = Array.from({ length: n }, () => rand() * Math.PI * 2).sort((a, b) => a - b);
    const raw = angles.map((a) => {
      let lon = centerLon + radiusLon * Math.cos(a);
      let lat = centerLat + radiusLat * Math.sin(a);
      lon = ((((lon + 180) % 360) + 360) % 360) - 180;
      lat = Math.max(-89.999, Math.min(89.999, lat));
      return [lat, lon];
    });
    const built = refBuild(raw);
    if (built.ambiguous || built.nonContractible) continue;
    const polyObj = raw.map(([lat, lon]) => ({ lat: lat.toFixed(7), lon: lon.toFixed(7) }));
    const qs = Array.from({ length: 12 }, () => {
      const lat = -80 + rand() * 160;
      const lon = -180 + rand() * 360;
      return { lat: lat.toFixed(4), lon: lon.toFixed(4) };
    });
    try {
      const results = classify({ polygon: polyObj, points: qs });
      compared++;
      const rev = classify({ polygon: [...polyObj].reverse(), points: qs });
      assert.deepEqual(rev, results, '反转顶点顺序后裁决变化');
      for (let k = 0; k < qs.length; k++) {
        if (results[k] === 'BOUNDARY') continue;
        const ref = refClassify(built, parseFloat(qs[k].lat), parseFloat(qs[k].lon));
        assert.equal(
          results[k], ref,
          `iter=${iter} q=${JSON.stringify(qs[k])} 精确=${results[k]} 参考=${ref}; poly=${JSON.stringify(raw)}`
        );
      }
    } catch (err) {
      if (err instanceof GeofenceError) continue; // 随机退化（自交/重合）多边形，跳过
      throw err;
    }
  }
  assert.ok(compared > 100, `有效随机用例过少（${compared}），差分测试可能未真正执行`);
});

// ---------- HTTP 层 ----------
async function httpTests() {
  const { createServer } = require('../src/server');
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  async function post(body, headers = {}) {
    return fetch(`${base}/api/geofences/classify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  }

  await testAsync('HTTP: 健康检查 200', async () => {
    const r = await fetch(`${base}/health`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { status: 'ok' });
  });

  await testAsync('HTTP: 正常分类 200 且保序', async () => {
    const r = await post({ polygon: square, points: [P(5, 5), P(50, 50), P(0, 0)] });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { results: ['INSIDE', 'OUTSIDE', 'BOUNDARY'] });
  });

  await testAsync('HTTP: 跨线围栏两侧同域', async () => {
    const r = await post({ polygon: strip, points: [P(0, 179.99), P(0, -179.99), P(0, 0)] });
    assert.deepEqual((await r.json()).results, ['INSIDE', 'INSIDE', 'OUTSIDE']);
  });

  await testAsync('HTTP: 非法围栏 400 且带 where 定位', async () => {
    const r = await post({ polygon: [P(0, 0), P(1, 1), P(2, 2)], points: [P(0, 0)] });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error.code, 'ZERO_AREA_POLYGON');
  });

  await testAsync('HTTP: 顶点/点位序号出现在错误中', async () => {
    const r = await post({ polygon: square, points: [P(5, 5), { lat: 'x', lon: 1 }] });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.ok(j.error.where.includes('points[1]'), JSON.stringify(j));
  });

  await testAsync('HTTP: 非法 JSON 返回 400', async () => {
    const r = await post('{not json');
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error.code, 'INVALID_JSON');
  });

  await testAsync('HTTP: 错误方法 405', async () => {
    const r = await fetch(`${base}/api/geofences/classify`);
    assert.equal(r.status, 405);
  });

  await testAsync('HTTP: 未知路由 404', async () => {
    const r = await fetch(`${base}/nope`);
    assert.equal(r.status, 404);
  });

  await testAsync('HTTP: 正文超过 1 MiB 返回 413', async () => {
    // 受字段数量上限约束，合法坐标本身不足以到 1 MiB；用超大字符串字段撑大正文，
    // 服务端必须在解析前按字节数拒绝（413），而不是按 JSON 语义处理。
    const big = {
      polygon: square,
      points: Array(400).fill(P(1.23456789012, 2.34567890123)),
      padding: 'x'.repeat(1024 * 1024 + 1024),
    };
    const payload = JSON.stringify(big);
    assert.ok(Buffer.byteLength(payload) > 1024 * 1024, '前置：正文确需超过 1 MiB');
    const r = await post(payload);
    assert.equal(r.status, 413);
    assert.equal((await r.json()).error.code, 'BODY_TOO_LARGE');
  });

  await new Promise((resolve) => server.close(resolve));
}

let asyncPassed = 0;
let asyncFailed = 0;
async function testAsync(name, fn) {
  try {
    await fn();
    asyncPassed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    asyncFailed++;
    console.error(`  ✗ ${name}`);
    console.error(err && err.stack ? err.stack.split('\n').slice(0, 5).join('\n') : err);
  }
}

(async () => {
  console.log('几何核心测试:');
  // 上面的同步 test 已在注册时执行
  await httpTests();
  const totalPass = passed + asyncPassed;
  const totalFail = failed + asyncFailed;
  console.log(`\n${totalPass} 通过, ${totalFail} 失败`);
  process.exit(totalFail === 0 ? 0 : 1);
})();
