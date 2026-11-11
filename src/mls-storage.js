const database = () => new Promise((resolve, reject) => {
  const request = indexedDB.open('lan-note-room-mls', 2);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains('rooms')) db.createObjectStore('rooms');
    if (!db.objectStoreNames.contains('leases')) db.createObjectStore('leases');
    if (!db.objectStoreNames.contains('history')) {
      db.createObjectStore('history', { keyPath: ['session', 'id'] })
        .createIndex('session', 'session');
    }
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

async function transaction(names, work) {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(names, 'readwrite');
      let result;
      let failure;
      const guard = operation => () => {
        try { operation(); }
        catch (error) { failure = error; tx.abort(); }
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure || tx.error || new Error('本地保存失败'));
      tx.onerror = () => reject(tx.error);
      guard(() => work(tx, value => { result = value; }, guard))();
    });
  } finally { db.close(); }
}

const historyRange = key => IDBKeyRange.bound([key, 0], [key, Infinity]);
const privateRecord = record => {
  const { history, owner, lease, ...state } = record;
  return state;
};
const checkOwner = (lease, owner) => {
  if (lease?.owner !== owner) throw new Error('加密会话被另一页面接管，已停止发送');
};

export function claimSession(key, owner, handoff, expiresAt) {
  return transaction(['rooms', 'leases', 'history'], (tx, done, guard) => {
    const rooms = tx.objectStore('rooms');
    const leases = tx.objectStore('leases');
    const history = tx.objectStore('history');
    const get = rooms.get(key);
    get.onsuccess = guard(() => {
      const previous = get.result || { cursor: 0 };
      const lease = leases.get(key);
      lease.onsuccess = guard(() => {
        // A v1 record keeps its lease until this session is migrated atomically.
        const occupied = lease.result || previous;
        if (occupied.owner && occupied.owner !== owner && occupied.owner !== handoff
          && occupied.lease > Date.now()) throw new Error('此身份正在另一个标签页使用，请关闭该页后重试');
        for (const message of previous.history || []) {
          history.put({ session: key, id: message.id, message });
        }
        const read = history.getAll(historyRange(key));
        read.onsuccess = guard(() => {
          const next = { ...privateRecord(previous), expiresAt };
          rooms.put(next, key);
          leases.put({ owner, lease: Date.now() + 10000, expiresAt }, key);
          done({ ...next, owner, history: read.result.map(item => item.message) });
        });
      });
    });
  });
}

export function saveSession(key, record, owner, messages = []) {
  return transaction(['rooms', 'leases', 'history'], (tx, _done, guard) => {
    const leases = tx.objectStore('leases');
    const request = leases.get(key);
    request.onsuccess = guard(() => {
      checkOwner(request.result, owner);
      tx.objectStore('rooms').put(privateRecord(record), key);
      leases.put({ owner, lease: Date.now() + 10000, expiresAt: record.expiresAt }, key);
      if (!messages.length) return;
      const history = tx.objectStore('history');
      for (const message of messages) history.put({ session: key, id: message.id, message });
      const count = history.count(historyRange(key));
      count.onsuccess = guard(() => {
        let excess = count.result - 1000;
        if (excess <= 0) return;
        const cursor = history.openCursor(historyRange(key));
        cursor.onsuccess = guard(() => {
          if (!cursor.result || excess-- <= 0) return;
          cursor.result.delete();
          cursor.result.continue();
        });
      });
    });
  });
}

export function renewLease(key, owner) {
  return transaction(['leases'], (tx, _done, guard) => {
    const store = tx.objectStore('leases');
    const request = store.get(key);
    request.onsuccess = guard(() => {
      checkOwner(request.result, owner);
      store.put({ ...request.result, lease: Date.now() + 10000 }, key);
    });
  });
}

export function releaseLease(key, owner) {
  return transaction(['leases'], (tx, _done, guard) => {
    const store = tx.objectStore('leases');
    const request = store.get(key);
    request.onsuccess = guard(() => {
      if (request.result?.owner === owner) {
        store.put({ ...request.result, owner: null, lease: 0 }, key);
      }
    });
  });
}

function deleteMatching(predicate) {
  return transaction(['rooms', 'leases', 'history'], (tx, _done, guard) => {
    const cursor = tx.objectStore('rooms').openCursor();
    cursor.onsuccess = guard(() => {
      if (!cursor.result) return;
      const { key, value } = cursor.result;
      if (predicate(key, value)) {
        cursor.result.delete();
        tx.objectStore('leases').delete(key);
        tx.objectStore('history').delete(historyRange(key));
      }
      cursor.result.continue();
    });
  });
}

export const removeRoomRecords = roomId =>
  deleteMatching(key => String(key).startsWith(`${roomId}:`));
export const removeSessionRecord = (roomId, session) =>
  deleteMatching(key => key === `${roomId}:${session}`);
export const pruneExpiredRecords = () =>
  deleteMatching((key, value) => Number.isFinite(value.expiresAt) && value.expiresAt <= Date.now());
