import type { AnnotationPosition, AnnotationAuthor, AnnotationReply } from "./annotation"

export interface Note {
  id: string
  number: number
  position: AnnotationPosition
  body: string
  author: AnnotationAuthor
  createdAt: string
  resolved: boolean
  replies: AnnotationReply[]
  mentions: string[]
  participantEmails: string[]
  projectId?: string
}
