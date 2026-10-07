# 海洋保护区地理围栏分类 API —— 零运行时依赖，仅需 Node.js
FROM node:22-alpine

WORKDIR /app

# 零第三方依赖：直接拷贝源码与测试，无需 npm install
COPY package.json ./
COPY src ./src
COPY test ./test
COPY scripts ./scripts

# 以非 root 用户运行
RUN addgroup -S app && adduser -S app -G app \
  && chown -R app:app /app
USER app

ENV NODE_ENV=production \
    PORT=8080

EXPOSE 8080

# 容器级健康检查（与 Compose 的 healthcheck 互为双保险）
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>{if(r.status!==200)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
