/** Russian strings of sign-in with SPA (Single Point of Authorization): the sign-in page, the user menu and Settings → SPA. */
export const ruIdentity: Record<string, string> = {
  // Sign-in page
  'Sign in with SPA': 'Войти через SPA',
  'Opening SPA…': 'Открываем SPA…',
  'You have signed out.': 'Вы вышли.',
  'Try again': 'Повторить',
  'Inventory DB did not answer. Try again later.': 'Inventory DB не ответила. Повторите позже.',
  'Passwords, passkeys and directory sign-in are handled by SPA.': 'Паролями, ключами доступа и входом через каталоги занимается SPA.',
  'This application is not connected to SPA': 'Это приложение не подключено к SPA',
  'Sign-in and access to Inventory DB are managed in SPA (Single Point of Authorization). To connect:':
    'Вход и доступ к Inventory DB управляются в SPA (Single Point of Authorization — единая точка авторизации). Чтобы подключить:',
  'In SPA, open Applications → Connect an application, choose the type Inventory DB and enter the address of Inventory DB.':
    'В SPA откройте Приложения → Подключить приложение, выберите тип Inventory DB и введите адрес Inventory DB.',
  'Give the Inventory DB roles (Administrator, Editor, Viewer) to people or groups.': 'Выдайте роли Inventory DB (Администратор, Редактор, Читатель) людям или группам.',
  'Copy the connection key (spa1.…) and give it to Inventory DB in the environment variable': 'Скопируйте ключ подключения (spa1.…) и передайте его Inventory DB в переменной окружения',
  '(or the file named by SPA_CONNECTION_KEY_FILE, or the secret spa / connection_key in OpenBao), then restart it.':
    '(или в файле из SPA_CONNECTION_KEY_FILE, или в секрете spa / connection_key в OpenBao), затем перезапустите её.',
  'How applications connect to SPA': 'Как приложения подключаются к SPA',
  // User menu
  'Account and security': 'Учётная запись и безопасность',
  // Settings → SPA
  'Sign-in and access are managed in SPA (Single Point of Authorization).': 'Вход и доступ управляются в SPA (Single Point of Authorization — единая точка авторизации).',
  'Sign-in and access are managed in SPA: passwords, passkeys, directories, sign-in providers and the roles of people in Inventory DB.':
    'Вход и доступ управляются в SPA: пароли, ключи доступа, каталоги, провайдеры входа и роли людей в Inventory DB.',
  Connection: 'Подключение',
  'Not connected': 'Не подключено',
  'Client ID': 'Client ID',
  'Connection key from': 'Ключ подключения из',
  'Secret store (spa / connection_key)': 'Хранилище секретов (spa / connection_key)',
  'Sign-in methods': 'Способы входа',
  'Role catalogue published': 'Каталог ролей опубликован',
  'The role catalogue could not be published to SPA': 'Не удалось опубликовать каталог ролей в SPA',
  Synchronization: 'Синхронизация',
  'Synchronize now': 'Синхронизировать сейчас',
  Synchronized: 'Синхронизировано',
  'Users and their roles are read from SPA every 5 minutes. People SPA disables or removes lose their sessions and API tokens here.':
    'Пользователи и их роли читаются из SPA каждые 5 минут. Те, кого SPA отключает или удаляет, теряют здесь сессии и API-токены.',
  'Last synchronization': 'Последняя синхронизация',
  'Last success': 'Последний успех',
  'Not yet': 'Ещё не было',
  'Users with access': 'Пользователи с доступом',
  'Created / updated / disabled': 'Создано / обновлено / отключено',
  'Bound to existing records': 'Привязано к существующим записям',
  'Active users here': 'Активные пользователи здесь',
  'Managed in SPA': 'Управляется в SPA',
  'User name': 'Имя пользователя',
  'DCIM/IPAM role': 'Роль DCIM/IPAM',
  Editor: 'Редактор',
  Viewer: 'Читатель',
  Disabled: 'Отключён',
  'Not yet in SPA': 'Ещё не в SPA',
  'SPA connection key': 'Ключ подключения SPA',
  'All Inventory DB secrets are kept in OpenBao: integration keys, the SPA connection key, the database password and the session signing key.':
    'Все секреты Inventory DB хранятся в OpenBao: ключи интеграций, ключ подключения SPA, пароль базы данных и ключ подписи сессий.',
  // Messages of the server
  'SPA did not answer. Try again later.': 'SPA не ответил. Повторите позже.',
  'SPA refused the sign-in or it was cancelled.': 'SPA отклонил вход, или вход был отменён.',
  'SPA sign-in could not be completed. Try again.': 'Не удалось завершить вход через SPA. Повторите.',
  'You have no access to Inventory DB. Ask an SPA administrator for a role.': 'У вас нет доступа к Inventory DB. Попросите администратора SPA выдать вам роль.',
  'Inventory DB is not connected to SPA': 'Inventory DB не подключена к SPA',
  'Roles are assigned in SPA': 'Роли назначаются в SPA',
  'This is not an SPA connection key (spa1.…): copy it again from SPA → Applications':
    'Это не ключ подключения SPA (spa1.…): скопируйте его заново в SPA → Приложения',
  'SPA refused the connection key (it was replaced or the application was removed): issue a new key in SPA':
    'SPA отклонил ключ подключения (он заменён или приложение удалено): выпустите новый ключ в SPA',
};
