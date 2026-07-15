FROM node:20-bookworm-slim

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
RUN mkdir -p /app/data/conversations /app/knowledge

ENV NODE_ENV=production PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server.js"]

