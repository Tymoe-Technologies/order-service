import { Router } from 'express';
import noteController from '../controllers/note.controller';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validation';
import {
  createNoteSchema,
  updateNoteSchema,
  createNoteTemplateSchema,
} from '../validators/note.validator';

const router = Router();

// Order notes
router.post(
  '/:orderId/notes',
  authenticate,
  validate(createNoteSchema),
  noteController.addNote
);
router.put(
  '/:orderId/notes/:noteId',
  authenticate,
  validate(updateNoteSchema),
  noteController.updateNote
);
router.delete('/:orderId/notes/:noteId', authenticate, noteController.deleteNote);

// Note templates
router.get('/note-templates', authenticate, noteController.getNoteTemplates);
router.post(
  '/note-templates',
  authenticate,
  validate(createNoteTemplateSchema),
  noteController.createNoteTemplate
);

export default router;
