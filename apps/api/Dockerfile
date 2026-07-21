FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/api apps/api
RUN npm run build -w @revive-psg1/api
RUN node -e "const fs=require('fs');const path=require('path');const fix=(d)=>{for(const f of fs.readdirSync(d)){const p=path.join(d,f);if(fs.statSync(p).isDirectory())fix(p);else if(p.endsWith('.js')){let s=fs.readFileSync(p,'utf8');s=s.replace(/from \\\"(\\.\\.?\\/[^\\\"]+)\\\"/g,(m,i)=>i.endsWith('.js')||i.startsWith('@')?m:'from \\\"'+i+'.js\\\"');fs.writeFileSync(p,s);}}};fix('apps/api/dist');fix('packages/contracts/dist');"

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci --omit=dev
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/packages/contracts/dist packages/contracts/dist
USER node
EXPOSE 8080
CMD ["node", "apps/api/dist/server.js"]
