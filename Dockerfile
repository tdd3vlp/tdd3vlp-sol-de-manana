FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY src ./src
COPY tsconfig.json ./
CMD ["npx", "tsx", "src/index.ts"]
