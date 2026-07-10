import { Request, Response, NextFunction } from 'express';
import noteService from '../services/note.service';
import { successResponse } from '../utils/response';

export class NoteController {
  async addNote(req: Request, res: Response, next: NextFunction) {
    try {
      const { orderId } = req.params;
      const userId = req.user!.userId;
      const tenantId = req.user!.tenantId;
      const result = await noteService.addNote(orderId, req.body, userId, tenantId);
      successResponse(res, result, 201);
    } catch (error) {
      next(error);
    }
  }

  async updateNote(req: Request, res: Response, next: NextFunction) {
    try {
      const { orderId, noteId } = req.params;
      const tenantId = req.user!.tenantId;
      const result = await noteService.updateNote(orderId, noteId, req.body, tenantId);
      successResponse(res, result);
    } catch (error) {
      next(error);
    }
  }

  async deleteNote(req: Request, res: Response, next: NextFunction) {
    try {
      const { orderId, noteId } = req.params;
      const tenantId = req.user!.tenantId;
      await noteService.deleteNote(orderId, noteId, tenantId);
      successResponse(res, { message: '便签已删除' });
    } catch (error) {
      next(error);
    }
  }

  async getNoteTemplates(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const result = await noteService.getNoteTemplates(tenantId);
      successResponse(res, result);
    } catch (error) {
      next(error);
    }
  }

  async createNoteTemplate(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const result = await noteService.createNoteTemplate(req.body, tenantId);
      successResponse(res, result, 201);
    } catch (error) {
      next(error);
    }
  }
}

export default new NoteController();
