FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .

ENV NODE_ENV=production
EXPOSE 8787

CMD ["npm", "run", "start"]
