const fs = require('fs');
const path = require('path');

function messageTime(message) {
  const value = message?.time || message?.createTime || message?.createdAt || '';
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function compactMessage(message) {
  return {
    id: String(message?.id || ''),
    sender: String(message?.sender || ''),
    content: String(message?.content || '').slice(0, 2000),
    time: message?.time || message?.createTime || new Date().toISOString(),
    createTime: message?.createTime || message?.time || new Date().toISOString(),
  };
}

class ConversationHistoryStore {
  constructor({ filePath, ttlMs = 30 * 60 * 1000, maxMessages = 16 } = {}) {
    this.filePath = filePath || path.join(process.cwd(), 'runtime', 'conversation-history.json');
    this.ttlMs = ttlMs;
    this.maxMessages = maxMessages;
    this.conversations = new Map();
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      for (const [key, messages] of Object.entries(raw?.conversations || {})) {
        if (Array.isArray(messages)) this.conversations.set(key, messages.map(compactMessage));
      }
    } catch (_) {}
    this.prune(false);
  }

  get(conversationId) {
    this.prune();
    return [...(this.conversations.get(conversationId || 'unknown') || [])];
  }

  remember(conversationId, message, reply = '') {
    const key = conversationId || 'unknown';
    const history = this.conversations.get(key) || [];
    history.push(compactMessage(message));
    if (reply) {
      history.push(compactMessage({
        id: `bot-reply|${Date.now()}`,
        sender: '酷太自动回复机器人',
        content: reply,
        time: new Date().toISOString(),
      }));
    }
    this.conversations.set(key, history.slice(-this.maxMessages));
    this.prune();
  }

  prune(save = true) {
    const cutoff = Date.now() - this.ttlMs;
    for (const [key, messages] of this.conversations.entries()) {
      const kept = messages.filter(message => {
        const time = messageTime(message);
        return !time || time >= cutoff;
      }).slice(-this.maxMessages);
      if (kept.length) this.conversations.set(key, kept);
      else this.conversations.delete(key);
    }
    if (save) this.save();
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const conversations = Object.fromEntries(this.conversations.entries());
      fs.writeFileSync(this.filePath, JSON.stringify({ version: 1, conversations }, null, 2), 'utf-8');
    } catch (error) {
      console.warn(`[会话上下文] 保存失败: ${error.message}`);
    }
  }
}

module.exports = { ConversationHistoryStore };
