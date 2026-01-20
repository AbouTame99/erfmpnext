# Copyright (c) 2025, Your Company and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class CustomerRFMScore(Document):
	def before_save(self):
		# Auto-generate RFM score string
		if self.recency_score and self.frequency_score and self.monetary_score:
			self.rfm_score = f"{self.recency_score}-{self.frequency_score}-{self.monetary_score}"
