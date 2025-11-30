FROM node:18

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY .env* ./
COPY . .

RUN npm run build

EXPOSE 6000

CMD [ "npm", "run", "start:prod" ]