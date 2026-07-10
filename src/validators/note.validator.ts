import Joi from 'joi';

export const createNoteSchema = Joi.object({
  noteType: Joi.string().valid('GENERAL', 'KITCHEN', 'CUSTOMER', 'INTERNAL').required(),
  content: Joi.string().required(),
  color: Joi.string().max(20).optional().allow(null),
  isPinned: Joi.boolean().default(false),
});

export const updateNoteSchema = Joi.object({
  content: Joi.string().optional(),
  color: Joi.string().max(20).optional().allow(null),
  isPinned: Joi.boolean().optional(),
});

export const createNoteTemplateSchema = Joi.object({
  name: Joi.string().max(255).required(),
  content: Joi.string().required(),
  color: Joi.string().max(20).optional().allow(null),
});
