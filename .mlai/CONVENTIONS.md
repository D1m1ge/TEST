# Проверка Mopeio

- Основной userscript: `Mopeio/mope-cheat.user.js`. `pxmodpack/` оставлен образцом старого клиента; не подменять им новый клиент целиком.
- Запуск на Windows: `Mopeio/launcher/run.bat`, Node.js 22+, Chrome/Edge. Переменные: `BROWSER`, `MOPE_CDP_PORT`, `MOPE_URL`.
- Локальные тесты: `node --test Mopeio/test/*.test.js`.
- Синтаксис: `node --check Mopeio/mope-cheat.user.js` и `node --check Mopeio/launcher/inject.js`.
- `Mopeio/test/verify.js` требует Windows Edge по умолчанию; на Linux проверка останавливается с ENOENT. Локальные тесты не доказывают работоспособность в живой игре.
- Рендер `test/harness.html` через browser file пригоден для осмотра панели, не для подтверждения игровых сценариев.
