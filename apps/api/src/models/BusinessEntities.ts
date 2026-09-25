import mongoose, { Schema, Document } from "mongoose";

// 1. Lead Model
export interface ILead extends Document {
  name: string;
  email: string;
  company: string;
  value: number;
  status: "new" | "contacted" | "qualified" | "inactive" | "converted" | "lost";
  lastContactedAt: Date;
  notes: string[];
  createdAt: Date;
}

const LeadSchema = new Schema<ILead>({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  company: { type: String, required: true },
  value: { type: Number, required: true, default: 0 },
  status: { type: String, enum: ["new", "contacted", "qualified", "inactive", "converted", "lost"], default: "new" },
  lastContactedAt: { type: Date, default: Date.now },
  notes: [{ type: String }],
  createdAt: { type: Date, default: Date.now }
});

export const LeadModel = mongoose.model<ILead>("Lead", LeadSchema);

// 2. Task Model
export interface ITask extends Document {
  title: string;
  leadId?: string;
  assignedTo?: string;
  priority: "LOW" | "MEDIUM" | "HIGH";
  status: "OPEN" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
  dueDate?: Date;
  createdAt: Date;
}

const TaskSchema = new Schema<ITask>({
  title: { type: String, required: true },
  leadId: { type: String },
  assignedTo: { type: String },
  priority: { type: String, enum: ["LOW", "MEDIUM", "HIGH"], default: "MEDIUM" },
  status: { type: String, enum: ["OPEN", "IN_PROGRESS", "COMPLETED", "CANCELLED"], default: "OPEN" },
  dueDate: { type: Date },
  createdAt: { type: Date, default: Date.now }
});

export const TaskModel = mongoose.model<ITask>("Task", TaskSchema);

// 3. Calendar Event Model
export interface ICalendarEvent extends Document {
  title: string;
  attendees: string[];
  startTime: Date;
  endTime: Date;
  status: "SCHEDULED" | "CANCELLED" | "COMPLETED";
  createdAt: Date;
}

const CalendarEventSchema = new Schema<ICalendarEvent>({
  title: { type: String, required: true },
  attendees: [{ type: String, required: true }],
  startTime: { type: Date, required: true },
  endTime: { type: Date, required: true },
  status: { type: String, enum: ["SCHEDULED", "CANCELLED", "COMPLETED"], default: "SCHEDULED" },
  createdAt: { type: Date, default: Date.now }
});

export const CalendarEventModel = mongoose.model<ICalendarEvent>("CalendarEvent", CalendarEventSchema);

// 4. Email Model
export interface IEmail extends Document {
  to: string;
  subject: string;
  body: string;
  status: "DRAFT" | "SENT" | "FAILED";
  sentAt?: Date;
  createdAt: Date;
}

const EmailSchema = new Schema<IEmail>({
  to: { type: String, required: true },
  subject: { type: String, required: true },
  body: { type: String, required: true },
  status: { type: String, enum: ["DRAFT", "SENT", "FAILED"], default: "DRAFT" },
  sentAt: { type: Date },
  createdAt: { type: Date, default: Date.now }
});

export const EmailModel = mongoose.model<IEmail>("Email", EmailSchema);

// 5. Tool Execution Record Model (Idempotency check)
export interface IToolExecution extends Document {
  orgId: string;
  userId: string;
  actionId: string;
  goalId: string;
  runId: string;
  stepId: string;
  tool: string;
  action: string;
  params: Record<string, unknown>;
  result: Record<string, unknown>;
  executedAt: Date;
}

const ToolExecutionSchema = new Schema<IToolExecution>({
  orgId: { type: String, required: true, index: true },
  userId: { type: String, required: true, index: true },
  actionId: { type: String, required: true, unique: true, index: true },
  goalId: { type: String, required: true },
  runId: { type: String, required: true },
  stepId: { type: String, required: true },
  tool: { type: String, required: true },
  action: { type: String, required: true },
  params: { type: Schema.Types.Mixed, default: {} },
  result: { type: Schema.Types.Mixed, default: {} },
  executedAt: { type: Date, default: Date.now }
});

export const ToolExecutionModel = mongoose.model<IToolExecution>("ToolExecution", ToolExecutionSchema);
