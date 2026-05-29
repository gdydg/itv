FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production \
    CLOUDFLARE_TURNSTILE_SITE_KEY="" \
    CLOUDFLARE_TURNSTILE_SECRET_KEY=""
EXPOSE 8787

CMD ["npm", "run", "start"]
