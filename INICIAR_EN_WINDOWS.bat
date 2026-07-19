@echo off
title Mi Compra Inteligente
cd /d "%~dp0"
echo.
echo ============================================
echo   MI COMPRA INTELIGENTE - SERVIDOR LOCAL
echo ============================================
echo.
echo La aplicacion se abrira en http://localhost:8080
echo Para cerrarla, vuelve a esta ventana y presiona Ctrl+C.
echo.

where py >nul 2>&1
if %errorlevel%==0 (
    start "" "http://localhost:8080"
    py -m http.server 8080
) else (
    where python >nul 2>&1
    if %errorlevel%==0 (
        start "" "http://localhost:8080"
        python -m http.server 8080
    ) else (
        echo No se encontro Python instalado.
        echo Instala Python o abre la carpeta con Live Server en Visual Studio Code.
        pause
    )
)
