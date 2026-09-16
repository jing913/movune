import { Schema, model } from 'mongoose'

type NotificationType = 'follow' | 'report_submitted'

type NotificationValidationContext = {
  type?: NotificationType
}

const notificationSchema = new Schema(
  {
    recipientId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    actorId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: function (this: NotificationValidationContext) {
        return this.type === 'follow'
      },
      validate: {
        validator: function (this: NotificationValidationContext, value: unknown) {
          return this.type === 'follow' || value == null
        },
        message: 'actorId is only supported for follow notifications',
      },
    },
    type: {
      type: String,
      enum: ['follow', 'report_submitted'],
      required: true,
    },
    reportId: {
      type: Schema.Types.ObjectId,
      ref: 'Report',
      required: function (this: NotificationValidationContext) {
        return this.type === 'report_submitted'
      },
      validate: {
        validator: function (this: NotificationValidationContext, value: unknown) {
          return this.type === 'report_submitted' || value == null
        },
        message: 'reportId is only supported for report_submitted notifications',
      },
    },
    messageId: {
      type: Schema.Types.ObjectId,
      ref: 'Message',
      validate: {
        validator: function (this: NotificationValidationContext, value: unknown) {
          return this.type === 'report_submitted' || value == null
        },
        message: 'messageId is only supported for report_submitted notifications',
      },
    },
    readAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  },
)

notificationSchema.index({ recipientId: 1, createdAt: -1, _id: -1 })

export const Notification = model('Notification', notificationSchema)
