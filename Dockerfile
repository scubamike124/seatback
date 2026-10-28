# Plain Node container for Seatback (Railway or any container host). No runtime dependencies to install.
# Pinned to a specific Node 22 patch release (22.22.0 satisfies engines >=22.18). ASSUMPTION: this tag exists on Docker Hub (official
# images publish <version>-slim tags); it could not be verified offline. If the build cannot pull it, use the newest node:22.x-slim.
FROM node:22.22.0-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY src ./src
COPY deploy ./deploy
USER node
EXPOSE 8080
ENV PORT=8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "deploy/node.ts"]
