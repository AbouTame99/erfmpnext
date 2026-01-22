frappe.pages['rfm-dashboard'].on_page_load = function (wrapper) {
    var page = frappe.ui.make_app_page({
        parent: wrapper,
        title: 'RFMP Analytics Dashboard',
        single_column: true
    });

    // Add Calculate button
    page.set_primary_action('Calculate RFMP Scores', () => {
        frappe.call({
            method: 'erfmpnext.erfmpnext.api.calculate_rfm_scores',
            freeze: true,
            freeze_message: 'Calculating RFMP scores...',
            callback: function (r) {
                if (r.message) {
                    frappe.msgprint({
                        title: 'RFMP Calculation Complete',
                        message: `Processed ${r.message.processed} customers. Created ${r.message.alerts_created} alerts.`,
                        indicator: 'green'
                    });
                    load_dashboard(page);
                }
            },
            error: function (r) {
                frappe.msgprint({
                    title: 'Calculation Error',
                    message: JSON.stringify(r),
                    indicator: 'red'
                });
            }
        });
    });

    // Add Product Analytics button
    page.set_secondary_action('Product Analytics', () => {
        frappe.set_route('product-analytics');
    });

    // Add Settings button
    page.add_inner_button('Settings', () => {
        frappe.set_route('Form', 'RFM Settings');
    });

    load_dashboard(page);
};

function load_dashboard(page) {
    page.body.html(`
        <div class="rfmp-dashboard">
            <div class="row">
                <div class="col-md-6">
                    <div class="card mb-4">
                        <div class="card-header">
                            <h5 class="mb-0">📊 Score Distribution (1-5 Scale)</h5>
                        </div>
                        <div class="card-body">
                            <div id="segment-chart" style="min-height: 250px;"></div>
                        </div>
                    </div>
                </div>
                <div class="col-md-6">
                    <div class="card mb-4">
                        <div class="card-header">
                            <h5 class="mb-0">🔔 Recent Alerts</h5>
                        </div>
                        <div class="card-body">
                            <div id="alerts-list" style="max-height: 250px; overflow-y: auto;"></div>
                        </div>
                    </div>
                </div>
            </div>
            <div class="row">
                <div class="col-12">
                    <div class="card mb-4">
                        <div class="card-header">
                            <h5 class="mb-0">👥 Customer Scores</h5>
                            <div class="rfmp-filter-group">
                                <select id="page-length-filter" class="form-control" style="width: 100px;">
                                    <option value="20">20 Rows</option>
                                    <option value="50">50 Rows</option>
                                    <option value="100">100 Rows</option>
                                    <option value="500">500 Rows</option>
                                </select>
                                <select id="score-filter" class="form-control" style="width: 150px;">
                                    <option value="">All Scores</option>
                                    <option value="5">5 (Excellent)</option>
                                    <option value="4">4 (Good)</option>
                                    <option value="3">3 (Average)</option>
                                    <option value="2">2 (Fair)</option>
                                    <option value="1">1 (Poor)</option>
                                </select>
                            </div>
                        </div>
                        <div class="card-body">
                            <div id="customers-table"></div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        <style>
            .rfmp-dashboard {
                padding: 10px;
                background-color: #f4f7fb;
            }
            .rfmp-dashboard .card {
                box-shadow: 0 4px 6px rgba(0,0,0,0.02), 0 10px 15px rgba(0,0,0,0.03);
                border: 1px solid rgba(0,0,0,0.05);
                border-radius: 12px;
                overflow: hidden;
                margin-bottom: 24px;
            }
            .rfmp-dashboard .card-header {
                background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);
                color: white;
                border: none;
                padding: 16px 24px;
                display: flex;
                justify-content: space-between;
                align-items: center;
            }
            .rfmp-dashboard .card-header h5 {
                font-weight: 600;
                letter-spacing: 0.5px;
                font-size: 1.1rem;
            }
            .rfmp-dashboard .card-body {
                padding: 24px;
            }
            
            /* Premium Filter Styling (Glassmorphism) */
            .rfmp-filter-group {
                display: flex;
                gap: 12px;
                background: rgba(255, 255, 255, 0.15);
                padding: 4px;
                border-radius: 10px;
                backdrop-filter: blur(4px);
                border: 1px solid rgba(255, 255, 255, 0.2);
            }
            .rfmp-dashboard select.form-control {
                background: rgba(255, 255, 255, 0.9);
                border: none;
                border-radius: 8px;
                padding: 6px 14px;
                height: auto;
                font-size: 13px;
                font-weight: 500;
                color: #4f46e5;
                cursor: pointer;
                transition: all 0.2s ease;
                box-shadow: 0 2px 4px rgba(0,0,0,0.05);
            }
            .rfmp-dashboard select.form-control:hover {
                background: #fff;
                transform: translateY(-1px);
                box-shadow: 0 4px 6px rgba(0,0,0,0.1);
            }
            .rfmp-dashboard select.form-control:focus {
                box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.2);
                outline: none;
            }

            .score-badge {
                display: inline-block;
                width: 28px;
                height: 28px;
                line-height: 28px;
                text-align: center;
                border-radius: 50%;
                font-weight: bold;
                font-size: 12px;
                box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            }
            .score-diamond { background: #10b981; color: white; }
            .score-gold { background: #f59e0b; color: white; }
            .score-silver { background: #9ca3af; color: white; }
            .score-bronze { background: #b45309; color: white; }
            .score-standard { background: #ef4444; color: white; }
            
            .alert-item {
                padding: 16px;
                border-bottom: 1px solid #f0f0f0;
                display: flex;
                justify-content: space-between;
                align-items: center;
                transition: background 0.2s;
            }
            .alert-item:hover {
                background: #f9fafb;
            }
            .alert-item:last-child { border-bottom: none; }
            .alert-downgrade { border-left: 4px solid #ef4444; }
            .alert-upgrade { border-left: 4px solid #10b981; }
            
            .avg-score {
                font-size: 16px;
                font-weight: 700;
                padding: 6px 14px;
                border-radius: 20px;
                box-shadow: inset 0 2px 4px rgba(0,0,0,0.05);
            }
            
            /* Progress Bars */
            .progress {
                background-color: #e5e7eb;
                border-radius: 10px;
                overflow: hidden;
            }
            .progress-bar {
                box-shadow: inset 0 2px 4px rgba(0,0,0,0.1);
            }
        </style>
    `);

    // Load segment distribution
    frappe.call({
        method: 'erfmpnext.erfmpnext.api.get_segment_distribution',
        callback: function (r) {
            if (r.message) render_segment_chart(r.message);
        }
    });

    // Load alerts
    frappe.call({
        method: 'erfmpnext.erfmpnext.api.get_alerts',
        args: { limit: 10, unread_only: false },
        callback: function (r) {
            render_alerts(r.message || []);
        }
    });

    // Load customers table
    load_customers_table();

    // Page Length change handler
    $(page.wrapper).on('change', '#page-length-filter', function () {
        current_page_length = parseInt($(this).val());
        load_customers_table(current_segment_filter, 0);
    });

    // Filter change handler (attached to wrapper)
    $(page.wrapper).on('change', '#score-filter', function () {
        load_customers_table($(this).val());
    });
}


function render_segment_chart(data) {
    const colors = {
        'Excellent (5)': '#10b981',
        'Good (4)': '#f59e0b',
        'Average (3)': '#9ca3af',
        'Fair (2)': '#b45309',
        'Poor (1)': '#ef4444'
    };

    let html = '<div class="segment-bars">';
    const total = data.reduce((sum, d) => sum + d.count, 0);

    data.forEach(d => {
        const pct = ((d.count / total) * 100).toFixed(1);
        const color = colors[d.segment] || '#6b7280';
        html += `
            <div class="mb-3">
                <div class="d-flex justify-content-between mb-1">
                    <span><span class="segment-badge" style="background: ${color}; color: white; padding: 4px 12px; border-radius: 12px;">${d.segment}</span></span>
                    <span class="font-weight-bold">${d.count} (${pct}%)</span>
                </div>
                <div class="progress" style="height: 8px;">
                    <div class="progress-bar" style="width: ${pct}%; background: ${color};"></div>
                </div>
            </div>
    `;
    });
    html += '</div>';
    $('#segment-chart').html(html);
}

function render_alerts(alerts) {
    if (!alerts.length) {
        $('#alerts-list').html('<p class="text-muted text-center">No alerts</p>');
        return;
    }

    let html = '';
    alerts.forEach(a => {
        const alertClass = a.alert_type === 'Downgrade' ? 'alert-downgrade' : 'alert-upgrade';
        const icon = a.alert_type === 'Downgrade' ? '⬇️' : '⬆️';
        html += `
            <div class="alert-item ${alertClass}">
                <div>
                    <strong>${icon} ${a.customer_name}</strong><br>
                    <small class="text-muted">Score: ${a.previous_segment} → ${a.new_segment}</small>
                </div>
                <small class="text-muted">${frappe.datetime.prettyDate(a.created_on)}</small>
            </div>
    `;
    });
    $('#alerts-list').html(html);
}

let current_page_length = 20;
let current_start = 0;
let current_segment_filter = null;

function load_customers_table(segment, start = 0) {
    if (segment !== undefined) {
        current_segment_filter = segment;
        current_start = 0; // Reset to page 1 on filter change
    } else {
        current_start = start;
    }

    // Show Loading State
    $('#customers-table').html(`
        <div class="text-center p-5">
            <div class="spinner-border text-primary" role="status"></div>
            <p class="mt-2 text-muted">Loading customer data...</p>
        </div>
    `);

    let filters = [];
    if (current_segment_filter) {
        let seg = parseInt(current_segment_filter);
        if (seg === 5) filters.push(["average_score", ">=", 5]);
        else if (seg === 4) { filters.push(["average_score", ">=", 4]); filters.push(["average_score", "<", 5]); }
        else if (seg === 3) { filters.push(["average_score", ">=", 3]); filters.push(["average_score", "<", 4]); }
        else if (seg === 2) { filters.push(["average_score", ">=", 2]); filters.push(["average_score", "<", 3]); }
        else if (seg === 1) filters.push(["average_score", "<", 2]);
    }

    frappe.call({
        method: 'frappe.client.get_list',
        args: {
            doctype: 'Customer RFM Score',
            filters: filters,
            fields: ['name', 'customer', 'customer_name', 'recency_score', 'frequency_score', 'monetary_score', 'payment_score', 'average_score', 'total_spent', 'total_orders', 'days_since_purchase', 'avg_days_late'],
            order_by: 'average_score desc',
            limit_start: current_start,
            limit_page_length: current_page_length
        },
        callback: function (r) {
            try {
                if (r.message && r.message.length) {
                    let html = `
                        <div class="table-responsive">
                            <table class="table table-hover">
                                <thead>
                                    <tr>
                                        <th>Customer</th>
                                        <th>R</th>
                                        <th>F</th>
                                        <th>M</th>
                                        <th>P</th>
                                        <th>Avg</th>
                                        <th>Total Spent</th>
                                        <th>Orders</th>
                                        <th>Days Late</th>
                                    </tr>
                                </thead>
                                <tbody>
                    `;
                    r.message.forEach(c => {
                        const avgClass = get_score_class(c.average_score);
                        html += `
                            <tr style="cursor: pointer;" onclick="frappe.set_route('Form', 'Customer RFM Score', '${c.name || c.customer}')">
                                <td><strong>${c.customer_name || c.customer}</strong></td>
                                <td><span class="score-badge ${get_score_badge_class(c.recency_score)}">${c.recency_score || '-'}</span></td>
                                <td><span class="score-badge ${get_score_badge_class(c.frequency_score)}">${c.frequency_score || '-'}</span></td>
                                <td><span class="score-badge ${get_score_badge_class(c.monetary_score)}">${c.monetary_score || '-'}</span></td>
                                <td><span class="score-badge ${get_score_badge_class(c.payment_score)}">${c.payment_score || '-'}</span></td>
                                <td><span class="avg-score ${avgClass}">${(c.average_score || 0).toFixed(1)}</span></td>
                                <td>${format_currency(c.total_spent || 0)}</td>
                                <td>${c.total_orders || 0}</td>
                                <td>${c.avg_days_late != null ? (c.avg_days_late > 0 ? '+' : '') + c.avg_days_late.toFixed(0) + 'd' : '-'}</td>
                            </tr>
                        `;
                    });
                    html += '</tbody></table></div>';

                    // Pagination Controls
                    let hasNext = r.message.length === current_page_length;
                    html += `
                        <div class="d-flex justify-content-between align-items-center mt-3">
                            <button class="btn btn-sm btn-secondary" onclick="load_customers_table(undefined, ${current_start - current_page_length})" ${current_start === 0 ? 'disabled' : ''}>
                                Previous
                            </button>
                            <span class="text-muted">Rows ${current_start + 1} - ${current_start + r.message.length}</span>
                            <button class="btn btn-sm btn-secondary" onclick="load_customers_table(undefined, ${current_start + current_page_length})" ${!hasNext ? 'disabled' : ''}>
                                Next
                            </button>
                        </div>
                    `;

                    $('#customers-table').html(html);
                } else {
                    if (current_start > 0) {
                        // Empty page but not the first one (should handle gracefully if user clicks next on last page, though logic prevents it)
                        $('#customers-table').html(`
                            <div class="text-center p-4">
                                <p class="text-muted">No more results.</p>
                                <button class="btn btn-sm btn-secondary" onclick="load_customers_table(undefined, ${current_start - current_page_length})">Go Back</button>
                            </div>
                         `);
                    } else {
                        $('#customers-table').html(`
                            <div class="text-center p-4">
                                <p class="text-muted">No customers found matching filter.</p>
                                <button class="btn btn-primary btn-sm" onclick="frappe.pages['rfm-dashboard'].get_primary_btn().trigger('click')">
                                    Calculate Scores Now
                                </button>
                            </div>
                        `);
                    }
                }
            } catch (e) {
                console.error(e);
                $('#customers-table').html(`<div class="alert alert-danger">JS Error: ${e.message}</div>`);
            }
        },
        error: function (r) {
            console.error(r);
            $('#customers-table').html(`<div class="alert alert-danger">Failed to fetch data. Please run 'bench migrate'.</div>`);
        }
    });
}

function get_score_class(score) {
    if (score >= 5) return 'score-diamond';
    if (score >= 4) return 'score-gold';
    if (score >= 3) return 'score-silver';
    if (score >= 2) return 'score-bronze';
    return 'score-standard';
}

function get_score_badge_class(score) {
    if (score >= 5) return 'score-diamond';
    if (score >= 4) return 'score-gold';
    if (score >= 3) return 'score-silver';
    if (score >= 2) return 'score-bronze';
    return 'score-standard';
}

function format_currency(value) {
    try {
        let currency = frappe.boot.sysdefaults.currency || 'USD';
        return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency }).format(value);
    } catch (e) {
        return (value || 0).toFixed(2);
    }
}
