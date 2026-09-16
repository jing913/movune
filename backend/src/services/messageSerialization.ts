type MessageRecord = {
  _id: { toString(): string }
  senderId: unknown
  clientMessageId: string
  contextType: string
  contextId: { toString(): string }
  content: string
  createdAt: Date
  updatedAt: Date
}

const senderId = (sender: unknown) => {
  if (typeof sender === 'object' && sender && '_id' in sender) {
    return String((sender as { _id: unknown })._id)
  }
  return String(sender)
}

export const serializeMessage = (message: MessageRecord) => ({
  id: message._id.toString(),
  senderId: senderId(message.senderId),
  sender:
    typeof message.senderId === 'object' && message.senderId && 'account' in message.senderId
      ? {
          id: senderId(message.senderId),
          account: String((message.senderId as { account: unknown }).account),
          displayName: (message.senderId as { displayName?: unknown }).displayName ?? null,
          avatar: (message.senderId as { avatar?: unknown }).avatar ?? null,
        }
      : undefined,
  clientMessageId: message.clientMessageId,
  contextType: message.contextType,
  contextId: message.contextId.toString(),
  content: message.content,
  createdAt: message.createdAt,
  updatedAt: message.updatedAt,
})
