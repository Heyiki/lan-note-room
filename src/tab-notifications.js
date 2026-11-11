export function createTabNotifications(document) {
  const title = document.title;
  let unread = 0;
  let lastId = 0;
  const clear = () => {
    unread = 0;
    document.title = title;
  };
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) clear();
  });
  return {
    receive(message, memberId, live) {
      if (message.id <= lastId) return;
      lastId = message.id;
      if (!live || message.memberId === memberId || !document.hidden) return;
      document.title = `（${++unread} 条新消息）${title}`;
    },
    reset() {
      lastId = 0;
      clear();
    }
  };
}
