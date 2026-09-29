/** Who issues PlanMeasure activation codes: Prompolu's WhatsApp (Morocco), international format for wa.me. */
export const VENDOR_NAME = "Prompolu";
export const VENDOR_WHATSAPP = "212668378538";

/** A WhatsApp link opening the chat with the vendor, message already written. */
export const whatsappToVendor = (text: string) => `https://wa.me/${VENDOR_WHATSAPP}?text=${encodeURIComponent(text)}`;
