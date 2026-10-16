# Transmitir Tela

Compartilhamento de tela em salas, estilo Discord. Programa Windows (Electron).

## Gerar o setup.exe (no Windows)
1. Instale o Node.js (https://nodejs.org).
2. Dê dois cliques em `GERAR-SETUP.bat` (ou rode `npm install` e `npm run dist`).
3. O instalador fica em `dist\Setup-Transmitir-Tela.exe`.

Para testar sem instalar: `npm install` e `npm start`.

## Como funciona
- Crie uma sala (ou entre com um código). O código não muda enquanto alguém estiver na sala.
- Todos podem compartilhar, inclusive ao mesmo tempo. Quem para de transmitir só deixa a sala sem imagem; ninguém é desconectado.
- Vídeo, áudio e chat vão direto entre os participantes (WebRTC em malha). O servidor ntfy só ajuda a se encontrarem pelo código (configurável em ⚙).

## Limites conhecidos
- Em malha, quem transmite envia o vídeo para cada pessoa; funciona bem para grupos pequenos (até uns 5 a 8).
- Redes muito restritas podem exigir um servidor TURN (não incluído).
- O áudio do sistema captura também o som das outras transmissões; por isso os outros ficam silenciados enquanto você transmite áudio (opção desmarcável).
