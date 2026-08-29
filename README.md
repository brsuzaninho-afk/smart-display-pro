# Smart Display Pro

Sistema de sinalização digital para TV com controle remoto pelo smartphone.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/brsuzaninho-afk/smart-display-pro)

## Como funciona

1. Abra `/tv.html` na TV.
2. Escaneie o QR Code com o celular.
3. O celular abre `/control.html?session=...`.
4. Envie imagem ou vídeo, escolha o modo e atualize a TV em tempo real.

## Modos

- Foto + movimento (Ken Burns + oferta)
- Vídeo + oferta
- Vídeo puro em tela cheia

## Produção

O projeto usa Fastify + Socket.IO e precisa de processo Node persistente com suporte a WebSocket. O arquivo `render.yaml` provisiona o serviço no Render com health check e disco persistente para uploads.
