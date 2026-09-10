FROM node:20-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production
COPY server.js .
COPY public ./public
EXPOSE 3838
CMD ["node", "server.js"]
