# Smart Display Pro

Sistema de sinalização digital para TV com controle remoto via smartphone.

## Rodar localmente

```bash
npm install
npm run dev
```

Abra `http://localhost:3000/tv.html` na TV e escaneie o QR Code com o celular.

## Produção

Use Node.js 20+ e um host com processo persistente e suporte a WebSocket. O servidor escuta em `0.0.0.0` e usa `PORT` do ambiente.
