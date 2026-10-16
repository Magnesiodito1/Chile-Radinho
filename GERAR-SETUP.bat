@echo off
chcp 65001 >nul
echo Instalando dependencias (precisa do Node.js: https://nodejs.org)...
call npm install
if errorlevel 1 goto erro
echo Gerando o instalador...
call npm run dist
if errorlevel 1 goto erro
echo.
echo Pronto! O instalador esta em: dist\Setup-Transmitir-Tela.exe
pause
exit /b 0
:erro
echo Algo deu errado. Confira se o Node.js esta instalado e se ha internet.
pause
exit /b 1
