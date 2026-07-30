export function emptyMessageChanges(): {
  messages: number;
  total: number;
  date: number;
  senderId: number;
  senderName: number;
  text: number;
  replyToMessageId: number;
} {
  return {
    messages: 0,
    total: 0,
    date: 0,
    senderId: 0,
    senderName: 0,
    text: 0,
    replyToMessageId: 0,
  };
}
