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

## Novidades da 1.1
- **Microfone:** escolha o dispositivo em ⚙ Opções, ligue/desligue com o botão 🎤 na barra. A voz vai em uma faixa separada e funciona mesmo sem ninguém transmitir.
- **Foto e GIF no perfil:** ⚙ Personalização (ou clique no seu avatar). Fotos são reduzidas; GIF animado até 1 MB.
- **Modo escuro AMOLED**, **cronômetro da sala** (sincronizado entre os participantes) e aba de **Opções**.
- **Botão direito em uma pessoa** (ou o botão ⋯): silenciar voz, volume, parar de assistir e **Remover da transmissão** (vermelho).
- **720p mais nítido:** novo seletor *Prioridade* (Nitidez/Fluidez, padrão Nitidez) e teto de bitrate maior. O seu quadro mostra "limitado por banda/CPU" quando a rede ou o PC não dão conta.

## Limites conhecidos
- "Remover da transmissão" corta o seu vídeo/áudio do PC para aquela pessoa, mas ela continua na sala (chat e voz). Quem sabe o código pode reentrar com outro nome.
- Enquanto você transmite o áudio do PC, as vozes dos outros ficam silenciadas aqui (o áudio do sistema as capturaria e geraria eco). Desmarque "Compartilhar áudio do PC" para conversar por voz.
- Em malha, quem transmite envia o vídeo para cada pessoa; funciona bem para grupos pequenos (até uns 5 a 8).
- Redes muito restritas podem exigir um servidor TURN (não incluído).
- O áudio do sistema captura também o som das outras transmissões; por isso os outros ficam silenciados enquanto você transmite áudio (opção desmarcável).
