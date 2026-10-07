# 海洋保护区地理围栏分类 API

判断船位（一组点）是否落入**单个管制区多边形**，多边形可能跨越 180° 经线
（国际日期变更线）。全部判定使用 BigInt 精确十进制运算，落在顶点或边上的点
**稳定返回 `BOUNDARY`**，不存在浮点误差导致的跨系统结论分歧。

- 零运行时第三方依赖，仅需 Node.js ≥ 20（推荐 22）
- 一条路由：`POST /api/geofences/classify`
- 健康检查：`GET /health`

## 快速开始（Docker Compose，清洁环境免账号免配置）

```bash
# 默认宿主机端口 8080
docker compose up --build

# 自定义宿主机端口
GEOFENCE_HOST_PORT=9090 docker compose up --build
```

API 就绪前 Compose 会持续健康检查；健康后即可调用：

```bash
curl -s http://localhost:8080/health
# {"status":"ok"}
```

### 一次性核对服务 verify

构建检查、单元/HTTP 测试、跨日期变更线分类与非法围栏拒绝的端到端核对，
全部通过后自行退出并以退出码 0 报告：

```bash
docker compose up --build verify
# ... 末尾出现 “verify 结果：全部通过 ✓”，退出码 0
```

## 不使用 Docker 的本地运行

```bash
npm test            # 运行全部测试（35 项）
PORT=8080 npm start # 启动 API
node scripts/verify.js   # 对运行中的 API 跑端到端核对（API_URL 可覆盖地址）
```

## 接口约定

### 请求

`POST /api/geofences/classify`，`Content-Type: application/json`，正文不超过
**1 MiB**（超出返回 `413`）。

```json
{
  "polygon": [
    {"lat": "10",  "lon": "170"},
    {"lat": "10",  "lon": "-170"},
    {"lat": "-10", "lon": "-170"},
    {"lat": "-10", "lon": "170"}
  ],
  "points": [
    {"lat": "0", "lon": "179.9999"},
    {"lat": "0", "lon": "-179.9999"},
    {"lat": "0", "lon": "0"}
  ]
}
```

| 字段 | 约束 |
| --- | --- |
| `polygon` | 3–128 个顶点，按顶点顺序围成的**简单多边形**（支持 CW/CCW，二者裁决一致） |
| `points` | 1–500 个待判点 |
| `lat` | 有限十进制数，开区间 **(-90, 90)** |
| `lon` | 有限十进制数，左闭右开区间 **[-180, 180)** |

边沿相邻两点经度间的**较短方向**连接，因此上例表示跨日期变更线、
覆盖 170°E–180° 与 180°–170°W 的单一管制带，变更线两侧的点得到一致结论。

### 响应 `200`

`results` 与 `points` 等长、**严格按点位原顺序**返回：

```json
{ "results": ["INSIDE", "INSIDE", "OUTSIDE"] }
```

- `INSIDE`：严格位于管制区内部
- `BOUNDARY`：与某条边重合（含顶点）；判定精确，重复请求稳定
- `OUTSIDE`：位于外部

### 错误响应

`400/405/413`，错误体可定位到顶点或点位序号（从 0 起）：

```json
{ "error": { "code": "LAT_OUT_OF_RANGE", "message": "...", "where": "points[1].lat" } }
```

| code | 触发条件 |
| --- | --- |
| `INVALID_JSON` / `BODY_TOO_LARGE` / `METHOD_NOT_ALLOWED` / `NOT_FOUND` | 协议层 |
| `INVALID_POLYGON` / `INVALID_POINTS` | 顶点 3–128、点位 1–500、类型错误 |
| `INVALID_COORDINATE` | 非有限十进制数、缺 lat/lon（定位到 `polygon[i].lat` 等） |
| `LAT_OUT_OF_RANGE` / `LON_OUT_OF_RANGE` | 纬度 ∉ (-90,90)、经度 ∉ [-180,180) |
| `DUPLICATE_VERTEX` | 重复/相邻重复顶点（定位到后一个顶点序号） |
| `ANTIMERIDIAN_AMBIGUOUS_EDGE` | 相邻经度恰差 180°，较短方向不唯一 |
| `NON_CONTRACTIBLE_POLYGON` | 各边按较短方向连接后整体环绕地球一周，内外不唯一 |
| `ZERO_AREA_POLYGON` | 共线等零面积退化 |
| `SELF_INTERSECTING_POLYGON` | 自交、T 接或相邻边折返重叠 |

## 设计说明

1. **统一标度精确运算**：取请求内所有坐标的最大小数位数 K，将坐标放大为
   10^K 倍的 BigInt 整数；叉积、交点、在线判定全程整数运算，从根本上保证
   `BOUNDARY` 的稳定性。
2. **柱面展开处理日期变更线**：逐边取最短经度方向（差 > 180° 时把后续顶点
   平移 ±360°），把环展开为连续平面折线；恰差 180° 无唯一短弧，拒绝。
   待判点生成 q±360°、q 三个经度周期副本参与判定。
3. **绕地球一周拒绝**：若最短方向展开后闭合边连到起点的 ±360° 周期副本
   （如倾斜纬环），该曲线在柱面上内外不唯一、正反向裁决互补，与
   “反转顺序裁决不变”冲突，返回 `NON_CONTRACTIBLE_POLYGON`，提示沿日期
   变更线拆分为多个围栏。
4. **简单性校验**：重复顶点、零面积、非相邻边相交、钉子式折返/重叠全部拒绝。
5. **反转不变**：射线法奇偶填充与方向无关，有向面积仅用于零面积检测（取零判断）。

## 目录结构

```
src/geometry.js   # 精确几何核心（解析/校验/展开/判定）
src/server.js     # 零依赖 HTTP API + /health
test/run-tests.js # 35 项单元/HTTP/随机差分测试
scripts/verify.js # Compose verify 一次性核对脚本
Dockerfile        # node:22-alpine，非 root，内置 HEALTHCHECK
docker-compose.yml# api（可配置宿主端口）+ verify（一次性，依赖健康）
```
