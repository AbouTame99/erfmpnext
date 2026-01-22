frappe.pages['product-analytics'].on_page_load = function (wrapper) {
    var page = frappe.ui.make_app_page({
        parent: wrapper,
        title: 'Product Performance Analytics',
        single_column: true
    });

    // Add Calculate button
    page.set_primary_action('Calculate Product Analytics', () => {
        frappe.call({
            method: 'erfmpnext.erfmpnext.api.calculate_product_analytics',
            freeze: true,
            freeze_message: 'Analyzing sales & stock patterns...',
            callback: function (r) {
                if (r.message && r.message.processed) {
                    frappe.show_alert({
                        message: `Processed ${r.message.processed} items successfully.`,
                        indicator: 'green'
                    });
                    load_product_dashboard(page);
                }
            }
        });
    });

    load_product_dashboard(page);
};

function load_product_dashboard(page) {
    page.body.html(`
        <div class="product-analytics-dashboard">
            <!-- Row 1: The Matrix and Metrics -->
            <div class="row">
                <div class="col-md-7">
                    <div class="card mb-4">
                        <div class="card-header">
                            <h5 class="mb-0">📦 ABC-XYZ Performance Matrix</h5>
                        </div>
                        <div class="card-body">
                            <div class="matrix-container" id="abc-xyz-matrix">
                                <div class="text-center p-5"><div class="spinner-border text-primary"></div></div>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="col-md-5">
                    <div class="card mb-4">
                        <div class="card-header">
                            <h5 class="mb-0">🧺 Market Basket (Top Picks)</h5>
                        </div>
                        <div class="card-body p-0">
                            <div id="basket-analysis-list" style="max-height: 400px; overflow-y: auto;">
                                <div class="text-center p-5"><div class="spinner-border text-primary"></div></div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Row 2: Detailed Table -->
            <div class="row">
                <div class="col-12">
                    <div class="card mb-4">
                        <div class="card-header d-flex justify-content-between align-items-center">
                            <h5 class="mb-0">📊 Item Performance & Financials</h5>
                            <div class="rfmp-filter-group">
                                <select id="abc-filter" class="form-control" style="width: 120px;">
                                    <option value="">All ABC</option>
                                    <option value="A">Class A (Top)</option>
                                    <option value="B">Class B (Mid)</option>
                                    <option value="C">Class C (Low)</option>
                                </select>
                                <select id="xyz-filter" class="form-control" style="width: 120px;">
                                    <option value="">All XYZ</option>
                                    <option value="X">Class X (Steady)</option>
                                    <option value="Y">Class Y (Fluctuating)</option>
                                    <option value="Z">Class Z (Random)</option>
                                </select>
                            </div>
                        </div>
                        <div class="card-body">
                            <div id="items-analytics-table">
                                <div class="text-center p-5"><div class="spinner-border text-primary"></div></div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <style>
            .product-analytics-dashboard { padding: 10px; background-color: #f8fafc; }
            .product-analytics-dashboard .card {
                border-radius: 12px; border: 1px solid #e2e8f0; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); overflow: hidden;
            }
            .product-analytics-dashboard .card-header {
                background: linear-gradient(135deg, #1e293b 0%, #334155 100%); color: white; padding: 16px 24px;
            }
            
            /* Matrix Styling */
            .matrix-grid {
                display: grid; grid-template-columns: 40px repeat(3, 1fr); grid-template-rows: repeat(3, 1fr) 40px;
                gap: 8px; height: 350px;
            }
            .matrix-cell {
                border-radius: 8px; display: flex; flex-direction: column; align-items: center; justify-content: center;
                color: white; font-weight: bold; position: relative; transition: transform 0.2s;
            }
            .matrix-cell:hover { transform: scale(1.02); }
            .cell-label { font-size: 20px; }
            .cell-count { font-size: 12px; opacity: 0.9; }
            
            /* Matrix Colors */
            .cell-ax { background: #059669; } /* Star */
            .cell-ay { background: #10b981; }
            .cell-az { background: #34d399; }
            .cell-bx { background: #d97706; }
            .cell-by { background: #f59e0b; }
            .cell-bz { background: #fbbf24; }
            .cell-cx { background: #dc2626; } /* Risk */
            .cell-cy { background: #ef4444; }
            .cell-cz { background: #f87171; }

            .matrix-axis-label {
                display: flex; align-items: center; justify-content: center; font-weight: 600; color: #64748b; font-size: 12px;
            }

            .rfmp-filter-group {
                display: flex; gap: 8px; background: rgba(255, 255, 255, 0.1); padding: 4px; border-radius: 8px;
            }
            .product-analytics-dashboard select.form-control {
                background: white; border: none; border-radius: 6px; font-size: 12px; height: 32px;
            }

            .basket-item {
                padding: 12px 20px; border-bottom: 1px solid #f1f5f9; display: flex; justify-content: space-between; align-items: center;
            }
            .basket-item:hover { background: #f8fafc; }
            .badge-support { background: #e0f2fe; color: #0369a1; padding: 4px 8px; border-radius: 4px; font-size: 11px; }
        </style>
    `);

    load_matrix_data();
    load_basket_data();
    load_items_table();

    // Event Bindings
    $(page.wrapper).on('change', '#abc-filter, #xyz-filter', function () {
        load_items_table();
    });
}

function load_matrix_data() {
    frappe.call({
        method: 'frappe.client.get_list',
        args: {
            doctype: 'Item Analytics',
            fields: ['abc_category', 'xyz_category']
        },
        callback: function (r) {
            const counts = {};
            (r.message || []).forEach(item => {
                const key = (item.abc_category + item.xyz_category).toLowerCase();
                counts[key] = (counts[key] || 0) + 1;
            });

            const grid = `
                <div class="matrix-grid">
                    <div class="matrix-axis-label" style="grid-row: 1; grid-column: 1;">A</div>
                    <div class="matrix-axis-label" style="grid-row: 2; grid-column: 1;">B</div>
                    <div class="matrix-axis-label" style="grid-row: 3; grid-column: 1;">C</div>
                    
                    <div class="matrix-cell cell-ax">
                        <span class="cell-label">AX</span>
                        <span class="cell-count">${counts.ax || 0} items</span>
                    </div>
                    <div class="matrix-cell cell-ay">
                        <span class="cell-label">AY</span>
                        <span class="cell-count">${counts.ay || 0} items</span>
                    </div>
                    <div class="matrix-cell cell-az">
                        <span class="cell-label">AZ</span>
                        <span class="cell-count">${counts.az || 0} items</span>
                    </div>

                    <div class="matrix-cell cell-bx">
                        <span class="cell-label">BX</span>
                        <span class="cell-count">${counts.bx || 0} items</span>
                    </div>
                    <div class="matrix-cell cell-by">
                        <span class="cell-label">BY</span>
                        <span class="cell-count">${counts.by || 0} items</span>
                    </div>
                    <div class="matrix-cell cell-bz">
                        <span class="cell-label">BZ</span>
                        <span class="cell-count">${counts.bz || 0} items</span>
                    </div>

                    <div class="matrix-cell cell-cx">
                        <span class="cell-label">CX</span>
                        <span class="cell-count">${counts.cx || 0} items</span>
                    </div>
                    <div class="matrix-cell cell-cy">
                        <span class="cell-label">CY</span>
                        <span class="cell-count">${counts.cy || 0} items</span>
                    </div>
                    <div class="matrix-cell cell-cz">
                        <span class="cell-label">CZ</span>
                        <span class="cell-count">${counts.cz || 0} items</span>
                    </div>

                    <div class="matrix-axis-label" style="grid-row: 4; grid-column: 2;">X (Steady)</div>
                    <div class="matrix-axis-label" style="grid-row: 4; grid-column: 3;">Y (Variable)</div>
                    <div class="matrix-axis-label" style="grid-row: 4; grid-column: 4;">Z (Random)</div>
                </div>
            `;
            $('#abc-xyz-matrix').html(grid);
        }
    });
}

function load_basket_data() {
    frappe.call({
        method: 'frappe.client.get_list',
        args: {
            doctype: 'Item Basket Analysis',
            fields: ['item_a_name', 'item_b_name', 'confidence', 'support'],
            order_by: 'confidence desc',
            limit: 10
        },
        callback: function (r) {
            if (!r.message || !r.message.length) {
                $('#basket-analysis-list').html('<p class="p-4 text-muted text-center">No deep associations found yet.</p>');
                return;
            }
            let html = '';
            r.message.forEach(row => {
                html += `
                    <div class="basket-item">
                        <div>
                            <div style="font-size: 13px; font-weight: 600;">${row.item_a_name}</div>
                            <div style="font-size: 11px; color: #64748b;">often bought with <strong>${row.item_b_name}</strong></div>
                        </div>
                        <div class="text-right">
                            <span class="badge-support">${row.confidence.toFixed(1)}% Confidence</span>
                        </div>
                    </div>
                `;
            });
            $('#basket-analysis-list').html(html);
        }
    });
}

function load_items_table() {
    let filters = [];
    const abc = $('#abc-filter').val();
    const xyz = $('#xyz-filter').val();
    if (abc) filters.push(['abc_category', '=', abc]);
    if (xyz) filters.push(['xyz_category', '=', xyz]);

    frappe.call({
        method: 'frappe.client.get_list',
        args: {
            doctype: 'Item Analytics',
            filters: filters,
            fields: ['item_code', 'item_name', 'abc_category', 'xyz_category', 'turnover_ratio', 'gmroi', 'revenue', 'profit', 'sales_count'],
            order_by: 'revenue desc',
            limit: 50
        },
        callback: function (r) {
            let html = `
                <div class="table-responsive">
                    <table class="table table-hover" style="font-size: 13px;">
                        <thead>
                            <tr style="background: #f1f5f9;">
                                <th>Item</th>
                                <th class="text-center">ABC</th>
                                <th class="text-center">XYZ</th>
                                <th class="text-right">Revenue</th>
                                <th class="text-right">Profit</th>
                                <th class="text-right">Turnover</th>
                                <th class="text-right">GMROI</th>
                            </tr>
                        </thead>
                        <tbody>
            `;

            (r.message || []).forEach(row => {
                const abcBadge = `<span class="badge badge-${row.abc_category === 'A' ? 'success' : (row.abc_category === 'B' ? 'warning' : 'danger')}">${row.abc_category}</span>`;
                const xyzBadge = `<span class="badge badge-info" style="background: ${row.xyz_category === 'X' ? '#0ea5e9' : (row.xyz_category === 'Y' ? '#3b82f6' : '#6366f1')}">${row.xyz_category}</span>`;

                html += `
                    <tr>
                        <td>
                            <div style="font-weight: 600; color: #1e293b;">${row.item_name}</div>
                            <small class="text-muted">${row.item_code}</small>
                        </td>
                        <td class="text-center">${abcBadge}</td>
                        <td class="text-center">${xyzBadge}</td>
                        <td class="text-right"><strong>${format_price(row.revenue)}</strong></td>
                        <td class="text-right text-success">${format_price(row.profit)}</td>
                        <td class="text-right">${row.turnover_ratio.toFixed(2)}x</td>
                        <td class="text-right"><strong>${row.gmroi.toFixed(2)}</strong></td>
                    </tr>
                `;
            });

            html += '</tbody></table></div>';
            $('#items-analytics-table').html(html);
        }
    });
}

function format_price(val) {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: frappe.boot.sysdefaults.currency || 'USD' }).format(val);
}
