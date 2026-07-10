import prisma from '../utils/prisma';
import { AppError } from '../middleware/errorHandler';
import logger from '../utils/logger';

interface CreateNoteData {
  noteType: 'GENERAL' | 'KITCHEN' | 'CUSTOMER' | 'INTERNAL';
  content: string;
  color?: string;
  isPinned?: boolean;
}

interface UpdateNoteData {
  content?: string;
  color?: string;
  isPinned?: boolean;
}

interface CreateNoteTemplateData {
  name: string;
  content: string;
  color?: string;
}

export class NoteService {
  async addNote(orderId: string, data: CreateNoteData, userId: string, tenantId: string) {
    const order = await prisma.order.findFirst({
      where: { id: orderId, tenantId },
    });

    if (!order) {
      throw new AppError(404, 'ORDER_NOT_FOUND', '订单不存在');
    }

    const note = await prisma.orderNote.create({
      data: {
        orderId,
        noteType: data.noteType,
        content: data.content,
        color: data.color || null,
        isPinned: data.isPinned || false,
        createdBy: userId,
      },
    });

    logger.info(`Note added to order: ${orderId}`, { noteId: note.id });

    return {
      id: note.id,
      content: note.content,
      noteType: note.noteType,
      isPinned: note.isPinned,
      createdAt: note.createdAt,
    };
  }

  async updateNote(
    orderId: string,
    noteId: string,
    data: UpdateNoteData,
    tenantId: string
  ) {
    const order = await prisma.order.findFirst({
      where: { id: orderId, tenantId },
    });

    if (!order) {
      throw new AppError(404, 'ORDER_NOT_FOUND', '订单不存在');
    }

    const note = await prisma.orderNote.findFirst({
      where: { id: noteId, orderId },
    });

    if (!note) {
      throw new AppError(404, 'NOTE_NOT_FOUND', '便签不存在');
    }

    const updatedNote = await prisma.orderNote.update({
      where: { id: noteId },
      data: {
        content: data.content !== undefined ? data.content : note.content,
        color: data.color !== undefined ? data.color : note.color,
        isPinned: data.isPinned !== undefined ? data.isPinned : note.isPinned,
      },
    });

    logger.info(`Note updated: ${noteId}`);

    return {
      id: updatedNote.id,
      content: updatedNote.content,
      updatedAt: updatedNote.createdAt,
    };
  }

  async deleteNote(orderId: string, noteId: string, tenantId: string) {
    const order = await prisma.order.findFirst({
      where: { id: orderId, tenantId },
    });

    if (!order) {
      throw new AppError(404, 'ORDER_NOT_FOUND', '订单不存在');
    }

    const note = await prisma.orderNote.findFirst({
      where: { id: noteId, orderId },
    });

    if (!note) {
      throw new AppError(404, 'NOTE_NOT_FOUND', '便签不存在');
    }

    await prisma.orderNote.delete({
      where: { id: noteId },
    });

    logger.info(`Note deleted: ${noteId}`);
  }

  async getNoteTemplates(tenantId: string) {
    const templates = await prisma.noteTemplate.findMany({
      where: { tenantId, isActive: true },
      orderBy: { createdAt: 'desc' },
    });

    return templates;
  }

  async createNoteTemplate(data: CreateNoteTemplateData, tenantId: string) {
    const template = await prisma.noteTemplate.create({
      data: {
        tenantId,
        name: data.name,
        content: data.content,
        color: data.color || null,
      },
    });

    logger.info(`Note template created: ${template.id}`);

    return {
      id: template.id,
      name: template.name,
      createdAt: template.createdAt,
    };
  }
}

export default new NoteService();
