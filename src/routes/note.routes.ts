import { Router } from 'express';
import noteController from '../controllers/note.controller';
import { authenticate } from '../middleware/auth';
import { requireModulePermission } from '../middleware/requirePermission';
import { validate } from '../middleware/validation';
import {
  createNoteSchema,
  updateNoteSchema,
  createNoteTemplateSchema,
} from '../validators/note.validator';

const router = Router();
const requireOrders = requireModulePermission('orders');

// Order notes
router.post(
  '/:orderId/notes',
  authenticate,
  requireOrders,
  validate(createNoteSchema),
  noteController.addNote
);
router.put(
  '/:orderId/notes/:noteId',
  authenticate,
  requireOrders,
  validate(updateNoteSchema),
  noteController.updateNote
);
router.delete('/:orderId/notes/:noteId', authenticate, requireOrders, noteController.deleteNote);

// Note templates
router.get('/note-templates', authenticate, requireOrders, noteController.getNoteTemplates);
router.post(
  '/note-templates',
  authenticate,
  requireOrders,
  validate(createNoteTemplateSchema),
  noteController.createNoteTemplate
);

export default router;
