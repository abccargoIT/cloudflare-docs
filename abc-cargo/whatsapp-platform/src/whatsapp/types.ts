/**
 * Minimal typings for the WhatsApp Business Platform (Cloud API) webhook
 * payloads and send endpoints. Only the fields this platform uses are typed.
 * See Meta's "Webhooks" and "Messages" references for the full shape.
 */

export interface WebhookPayload {
	object: string;
	entry: WebhookEntry[];
}

export interface WebhookEntry {
	/** WhatsApp Business Account ID */
	id: string;
	changes: WebhookChange[];
}

export interface WebhookChange {
	field: string;
	value: WebhookValue;
}

export interface WebhookValue {
	messaging_product: "whatsapp";
	metadata: {
		display_phone_number: string;
		phone_number_id: string;
	};
	contacts?: WebhookContact[];
	messages?: InboundMessage[];
	statuses?: MessageStatus[];
	errors?: MetaError[];
}

export interface WebhookContact {
	profile: { name: string };
	wa_id: string;
}

export interface MediaObject {
	id: string;
	mime_type: string;
	sha256?: string;
	caption?: string;
	filename?: string;
}

export type InboundMessageType =
	| "text"
	| "image"
	| "document"
	| "audio"
	| "video"
	| "sticker"
	| "location"
	| "contacts"
	| "interactive"
	| "button"
	| "reaction"
	| "order"
	| "system"
	| "unsupported"
	| "unknown";

export interface InboundMessage {
	from: string;
	id: string;
	/** Unix seconds as a string */
	timestamp: string;
	type: InboundMessageType | string;
	text?: { body: string };
	image?: MediaObject;
	document?: MediaObject;
	audio?: MediaObject;
	video?: MediaObject;
	sticker?: MediaObject;
	location?: {
		latitude: number;
		longitude: number;
		name?: string;
		address?: string;
	};
	interactive?: {
		type: "button_reply" | "list_reply";
		button_reply?: { id: string; title: string };
		list_reply?: { id: string; title: string; description?: string };
	};
	button?: { payload: string; text: string };
	reaction?: { message_id: string; emoji: string };
	context?: { from: string; id: string };
	errors?: MetaError[];
}

export type DeliveryStatus =
	"sent" | "delivered" | "read" | "failed" | "deleted";

export interface MessageStatus {
	id: string;
	status: DeliveryStatus;
	timestamp: string;
	recipient_id: string;
	conversation?: {
		id: string;
		origin: { type: string };
		expiration_timestamp?: string;
	};
	pricing?: {
		billable: boolean;
		pricing_model: string;
		category: string;
	};
	errors?: MetaError[];
}

export interface MetaError {
	code: number;
	title: string;
	message?: string;
	error_data?: { details: string };
}

export interface SendMessageResponse {
	messaging_product: "whatsapp";
	contacts: { input: string; wa_id: string }[];
	messages: { id: string; message_status?: string }[];
}

export interface TemplateComponent {
	type: "header" | "body" | "button";
	sub_type?: "quick_reply" | "url";
	index?: string;
	parameters: TemplateParameter[];
}

export type TemplateParameter =
	| { type: "text"; text: string }
	| {
			type: "currency";
			currency: { fallback_value: string; code: string; amount_1000: number };
	  }
	| { type: "date_time"; date_time: { fallback_value: string } }
	| { type: "image"; image: { link: string } }
	| { type: "document"; document: { link: string; filename?: string } }
	| { type: "payload"; payload: string };

export interface TemplateSendRequest {
	name: string;
	languageCode: string;
	components?: TemplateComponent[];
}

export interface MediaUrlResponse {
	url: string;
	mime_type: string;
	sha256: string;
	file_size: number;
	id: string;
	messaging_product: "whatsapp";
}
