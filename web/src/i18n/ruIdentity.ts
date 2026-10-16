/** Russian strings of sign-in with Keystone: the sign-in page, the user menu and Settings → Keystone. */
export const ruIdentity: Record<string, string> = {
  // Sign-in page
  'Sign in with Keystone': 'Войти через Keystone',
  'Opening Keystone…': 'Открываем Keystone…',
  'You have signed out.': 'Вы вышли.',
  'Try again': 'Повторить',
  'Ledger did not answer. Try again later.': 'Ledger не ответил. Повторите позже.',
  'Passwords, passkeys and directory sign-in are handled by Keystone.': 'Паролями, ключами доступа и входом через каталоги занимается Keystone.',
  'This application is not connected to Keystone': 'Это приложение не подключено к Keystone',
  'Sign-in and access to Ledger are managed in Keystone. To connect:':
    'Вход и доступ к Ledger управляются в Keystone. Чтобы подключить:',
  'In Keystone, open Applications → Connect an application, choose the type Ledger and enter the address of Ledger.':
    'В Keystone откройте Приложения → Подключить приложение, выберите тип Ledger и введите адрес Ledger.',
  'Give the Ledger roles (Administrator, Editor, Viewer) to people or groups.': 'Выдайте роли Ledger (Администратор, Редактор, Читатель) людям или группам.',
  'Copy the connection key (spa1.…) and give it to Ledger in the environment variable': 'Скопируйте ключ подключения (spa1.…) и передайте его Ledger в переменной окружения',
  '(or the file named by SPA_CONNECTION_KEY_FILE, or the secret spa / connection_key in OpenBao), then restart it.':
    '(или в файле из SPA_CONNECTION_KEY_FILE, или в секрете spa / connection_key в OpenBao), затем перезапустите её.',
  'How applications connect to Keystone': 'Как приложения подключаются к Keystone',
  // User menu
  'Account and security': 'Учётная запись и безопасность',
  // Settings → Keystone
  'Sign-in and access are managed in Keystone.': 'Вход и доступ управляются в Keystone.',
  'Sign-in and access are managed in Keystone: passwords, passkeys, directories, sign-in providers and the roles of people in Ledger.':
    'Вход и доступ управляются в Keystone: пароли, ключи доступа, каталоги, провайдеры входа и роли людей в Ledger.',
  Connection: 'Подключение',
  'Not connected': 'Не подключено',
  'Client ID': 'Client ID',
  'Connection key from': 'Ключ подключения из',
  'Secret store (spa / connection_key)': 'Хранилище секретов (spa / connection_key)',
  'Sign-in methods': 'Способы входа',
  'Role catalogue published': 'Каталог ролей опубликован',
  'The role catalogue could not be published to Keystone': 'Не удалось опубликовать каталог ролей в Keystone',
  Synchronization: 'Синхронизация',
  'Synchronize now': 'Синхронизировать сейчас',
  Synchronized: 'Синхронизировано',
  'Users and their roles are read from Keystone every 5 minutes. People Keystone disables or removes lose their sessions here, and their API tokens are suspended until Keystone enables them again.':
    'Пользователи и их роли читаются из Keystone каждые 5 минут. Те, кого Keystone отключает или удаляет, теряют здесь сессии, а их API-токены приостанавливаются, пока Keystone снова их не включит.',
  Suspended: 'Приостановлен',
  'Suspended while Keystone has this person disabled or without a role here; it works again when Keystone enables them.':
    'Приостановлен, пока в Keystone этот человек отключён или не имеет роли здесь; снова заработает, когда Keystone его включит.',
  '{n} (suspended: {s})': '{n} (приостановлено: {s})',
  'Last synchronization': 'Последняя синхронизация',
  'Last success': 'Последний успех',
  'Not yet': 'Ещё не было',
  'Users with access': 'Пользователи с доступом',
  'Created / updated / disabled': 'Создано / обновлено / отключено',
  'Bound to existing records': 'Привязано к существующим записям',
  'Active users here': 'Активные пользователи здесь',
  'Managed in Keystone': 'Управляется в Keystone',
  'User name': 'Имя пользователя',
  'DCIM/IPAM role': 'Роль DCIM/IPAM',
  Editor: 'Редактор',
  Viewer: 'Читатель',
  Disabled: 'Отключён',
  'Not yet in Keystone': 'Ещё не в Keystone',
  'Keystone connection key': 'Ключ подключения Keystone',
  'All Ledger secrets are kept in OpenBao: integration keys, the Keystone connection key, the database password and the session signing key.':
    'Все секреты Ledger хранятся в OpenBao: ключи интеграций, ключ подключения Keystone, пароль базы данных и ключ подписи сессий.',
  // Messages of the server
  'Keystone did not answer. Try again later.': 'Keystone не ответил. Повторите позже.',
  'Keystone refused the sign-in or it was cancelled.': 'Keystone отклонил вход, или вход был отменён.',
  'Keystone sign-in could not be completed. Try again.': 'Не удалось завершить вход через Keystone. Повторите.',
  'You have no access to Ledger. Ask a Keystone administrator for a role.': 'У вас нет доступа к Ledger. Попросите администратора Keystone выдать вам роль.',
  'Ledger is not connected to Keystone': 'Ledger не подключён к Keystone',
  'Roles are assigned in Keystone': 'Роли назначаются в Keystone',
  'This is not a Keystone connection key (spa1.…): copy it again from Keystone → Applications':
    'Это не ключ подключения Keystone (spa1.…): скопируйте его заново в Keystone → Приложения',
  'Keystone refused the connection key (it was replaced or the application was removed): issue a new key in Keystone':
    'Keystone отклонил ключ подключения (он заменён или приложение удалено): выпустите новый ключ в Keystone',
};
