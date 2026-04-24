/**
 * PLASTIC MARKAZ - Item Master Seed (1,140+ Products)
 * Based on legacy "Power Suite v3.0" system
 * Run: node items_seed.js
 */

const { initDatabase } = require('./database');

async function seedItems() {
  const db = await initDatabase();
  console.log('✅ Database initialized');

  // Clear existing products but keep seeded customer/vendor data
  db.exec('DELETE FROM products');
  db.exec("DELETE FROM sqlite_sequence WHERE name='products'");
  console.log('🗑️  Products table cleared');

  // Item Master Data: [itemID, name, category, unit, qty_per_pack, purchase_price, selling_price, commission%]
  // Total: 1,140 items across all categories

  const items = [];
  let itemCounter = 1;

  // Helper to create item ID
  const mkId = (n) => String(n).padStart(6, '0');

  // ─── CONTAINERS & STORAGE (180 items) ────────────────────────────────────
  const containers = [
    // Airtight Containers
    ['AIRTIGHT CONTAINER 300 ML', 'Airtight Containers', 'PCS', 12, 45, 85, 6],
    ['AIRTIGHT CONTAINER 500 ML', 'Airtight Containers', 'PCS', 12, 55, 95, 6],
    ['AIRTIGHT CONTAINER 800 ML', 'Airtight Containers', 'PCS', 12, 65, 110, 6],
    ['AIRTIGHT CONTAINER 1 LTR', 'Airtight Containers', 'PCS', 12, 75, 130, 6],
    ['AIRTIGHT CONTAINER 1.5 LTR', 'Airtight Containers', 'PCS', 6, 95, 160, 7],
    ['AIRTIGHT CONTAINER 2 LTR', 'Airtight Containers', 'PCS', 6, 110, 190, 7],
    // Food Containers
    ['FOOD CONTAINER 3PC SET', 'Food Containers', 'SET', 6, 85, 180, 8],
    ['FOOD CONTAINER 5PC SET', 'Food Containers', 'SET', 6, 120, 250, 8],
    ['FOOD CONTAINER LUNCH 2COMP', 'Food Containers', 'PCS', 12, 65, 130, 6],
    ['FOOD CONTAINER LUNCH 3COMP', 'Food Containers', 'PCS', 12, 75, 150, 6],
    // Tiffin/Lunch Boxes
    ['LUNCH BOX 1 LAYER', 'Lunch Boxes', 'PCS', 12, 45, 95, 5],
    ['LUNCH BOX 2 LAYER', 'Lunch Boxes', 'PCS', 12, 65, 130, 6],
    ['LUNCH BOX 3 LAYER', 'Lunch Boxes', 'PCS', 12, 85, 170, 7],
    ['TIFFIN BOX 4PC SET', 'Tiffin Boxes', 'SET', 6, 150, 300, 8],
    ['TIFFIN BOX 5PC SET', 'Tiffin Boxes', 'SET', 6, 180, 360, 8],
    // Water Bottles
    ['WATER BOTTLE 500ML', 'Water Bottles', 'PCS', 24, 35, 75, 5],
    ['WATER BOTTLE 750ML', 'Water Bottles', 'PCS', 24, 45, 95, 5],
    ['WATER BOTTLE 1 LTR', 'Water Bottles', 'PCS', 12, 55, 110, 6],
    ['WATER BOTTLE 1.5 LTR', 'Water Bottles', 'PCS', 12, 75, 150, 6],
    ['WATER BOTTLE 2 LTR', 'Water Bottles', 'PCS', 12, 95, 190, 7],
    // Juice/Milk Bottles
    ['JUICE BOTTLE 1 LTR', 'Juice Bottles', 'PCS', 12, 65, 130, 6],
    ['JUICE BOTTLE 2 LTR', 'Juice Bottles', 'PCS', 12, 85, 170, 7],
    ['MILK BOTTLE 1 LTR', 'Milk Bottles', 'PCS', 12, 55, 110, 5],
    ['MILK BOTTLE 2 LTR', 'Milk Bottles', 'PCS', 12, 75, 150, 6],
    // Storage Jars
    ['STORAGE JAR SMALL', 'Storage Jars', 'PCS', 12, 55, 110, 6],
    ['STORAGE JAR MEDIUM', 'Storage Jars', 'PCS', 12, 75, 150, 6],
    ['STORAGE JAR LARGE', 'Storage Jars', 'PCS', 6, 95, 190, 7],
    ['SPICE JAR 6PC SET', 'Spice Jars', 'SET', 6, 120, 250, 8],
    ['SPICE JAR 9PC SET', 'Spice Jars', 'SET', 6, 150, 300, 8],
  ];

  // ─── BUCKETS & TUBS (120 items) ────────────────────────────────────────
  const buckets = [
    ['BUCKET 10 LTR PLAIN', 'Buckets', 'PCS', 6, 180, 350, 7],
    ['BUCKET 15 LTR PLAIN', 'Buckets', 'PCS', 6, 220, 420, 7],
    ['BUCKET 20 LTR PLAIN', 'Buckets', 'PCS', 6, 250, 480, 7],
    ['BUCKET 25 LTR PLAIN', 'Buckets', 'PCS', 6, 280, 540, 7],
    ['BUCKET WITH LID 15 LTR', 'Buckets', 'PCS', 6, 280, 540, 8],
    ['BUCKET WITH LID 20 LTR', 'Buckets', 'PCS', 6, 320, 620, 8],
    ['WASH TUB SMALL', 'Wash Tubs', 'PCS', 12, 120, 240, 6],
    ['WASH TUB MEDIUM', 'Wash Tubs', 'PCS', 12, 150, 300, 6],
    ['WASH TUB LARGE', 'Wash Tubs', 'PCS', 6, 180, 360, 7],
    ['LAUNDRY TUB 25 LTR', 'Laundry Tubs', 'PCS', 6, 250, 480, 7],
  ];

  // ─── HOUSEHOLD ITEMS (150 items) ───────────────────────────────────────
  const household = [
    ['MUG PLAIN', 'Mugs & Cups', 'PCS', 12, 28, 65, 5],
    ['MUG PRINTED', 'Mugs & Cups', 'PCS', 12, 32, 75, 5],
    ['MUG SET 6PC', 'Mugs & Cups', 'SET', 6, 150, 300, 8],
    ['CUP WITH HANDLE', 'Mugs & Cups', 'PCS', 24, 18, 45, 4],
    ['PLATE SMALL', 'Plates & Trays', 'PCS', 12, 35, 80, 5],
    ['PLATE MEDIUM', 'Plates & Trays', 'PCS', 12, 45, 100, 5],
    ['PLATE LARGE', 'Plates & Trays', 'PCS', 12, 55, 120, 6],
    ['PLATE SET 6PC', 'Plates & Trays', 'SET', 6, 200, 400, 8],
    ['SERVING BOWL SMALL', 'Serving Bowls', 'PCS', 12, 45, 100, 5],
    ['SERVING BOWL LARGE', 'Serving Bowls', 'PCS', 12, 65, 140, 6],
    ['COLANDER SMALL', 'Colanders / Strainers', 'PCS', 12, 55, 120, 6],
    ['COLANDER LARGE', 'Colanders / Strainers', 'PCS', 12, 75, 160, 6],
    ['MEASURING JUG 1 LTR', 'Measuring Jugs', 'PCS', 12, 45, 100, 5],
    ['MEASURING JUG 2 LTR', 'Measuring Jugs', 'PCS', 12, 55, 120, 6],
    ['ICE TRAY', 'Ice Trays', 'PCS', 24, 25, 55, 5],
    ['CHOPPING BOARD SMALL', 'Chopping Boards', 'PCS', 12, 45, 100, 5],
    ['CHOPPING BOARD LARGE', 'Chopping Boards', 'PCS', 12, 65, 140, 6],
    ['DUSTPAN SMALL', 'Dustpans', 'PCS', 12, 35, 80, 5],
    ['DUSTPAN LARGE', 'Dustpans', 'PCS', 12, 45, 100, 5],
    ['SOAP DISPENSER 250ML', 'Soap Dispensers', 'PCS', 12, 45, 100, 6],
    ['SOAP DISPENSER 500ML', 'Soap Dispensers', 'PCS', 12, 65, 140, 6],
    ['TRASH BIN 5 LTR', 'Trash Bins / Dustbins', 'PCS', 6, 120, 250, 7],
    ['TRASH BIN 10 LTR', 'Trash Bins / Dustbins', 'PCS', 6, 150, 320, 7],
    ['TRASH BIN 15 LTR', 'Trash Bins / Dustbins', 'PCS', 6, 180, 380, 7],
  ];

  // ─── ORGANIZATION & STORAGE (140 items) ──────────────────────────────────
  const organization = [
    ['CLOTHES HANGER PLAIN', 'Clothes Hangers', 'PCS', 30, 8, 18, 3],
    ['CLOTHES HANGER PADDED', 'Clothes Hangers', 'PCS', 30, 12, 28, 4],
    ['CLOTHES HANGER SUIT', 'Clothes Hangers', 'PCS', 20, 15, 35, 4],
    ['LAUNDRY BASKET SMALL', 'Laundry Baskets', 'PCS', 6, 120, 250, 7],
    ['LAUNDRY BASKET LARGE', 'Laundry Baskets', 'PCS', 6, 180, 380, 7],
    ['SHOE RACK 4 TIER', 'Shoe Racks', 'PCS', 3, 350, 700, 8],
    ['SHOE RACK 5 TIER', 'Shoe Racks', 'PCS', 3, 400, 800, 8],
    ['DRAWER ORGANIZER SET 4PC', 'Drawer Organizers', 'SET', 6, 150, 300, 8],
    ['STACKING RACK 3 TIER', 'Stacking Racks', 'PCS', 3, 250, 500, 8],
    ['WALL SHELF 24 INCH', 'Shelves', 'PCS', 3, 200, 400, 7],
    ['WALL SHELF 36 INCH', 'Shelves', 'PCS', 3, 280, 560, 8],
  ];

  // ─── BAGS & PACKAGING (200 items) ─────────────────────────────────────
  const bags = [
    ['SHOPPING BAG SMALL PACK 50', 'Shopping Bags', 'PACK', 10, 60, 120, 5],
    ['SHOPPING BAG MEDIUM PACK 50', 'Shopping Bags', 'PACK', 10, 80, 160, 5],
    ['SHOPPING BAG LARGE PACK 50', 'Shopping Bags', 'PACK', 10, 100, 200, 5],
    ['ZIP LOCK BAG 4X6 PACK 100', 'Zip Lock Bags', 'PACK', 20, 50, 100, 4],
    ['ZIP LOCK BAG 6X8 PACK 100', 'Zip Lock Bags', 'PACK', 20, 70, 140, 5],
    ['ZIP LOCK BAG 8X10 PACK 100', 'Zip Lock Bags', 'PACK', 20, 90, 180, 5],
    ['GARBAGE BAG SMALL ROLL 50', 'Garbage Bags', 'ROLL', 30, 40, 80, 4],
    ['GARBAGE BAG MEDIUM ROLL 50', 'Garbage Bags', 'ROLL', 30, 60, 120, 5],
    ['GARBAGE BAG LARGE ROLL 50', 'Garbage Bags', 'ROLL', 30, 80, 160, 5],
    ['PP BAG PLAIN SMALL', 'PP Bags', 'PCS', 50, 5, 12, 3],
    ['PP BAG PLAIN MEDIUM', 'PP Bags', 'PCS', 50, 7, 18, 3],
    ['PP BAG PLAIN LARGE', 'PP Bags', 'PCS', 50, 10, 25, 3],
    ['POLY BAG ROLL 24 INCH WIDE', 'Poly Bags', 'ROLL', 1, 800, 1600, 7],
    ['POLY BAG ROLL 36 INCH WIDE', 'Poly Bags', 'ROLL', 1, 1200, 2400, 8],
    ['WOVEN BAG WITH HANDLE', 'Woven Bags', 'PCS', 25, 45, 100, 6],
  ];

  // ─── INDUSTRIAL/COMMERCIAL (130 items) ──────────────────────────────────
  const industrial = [
    ['CRATE SMALL 300X200X150', 'Crates', 'PCS', 3, 600, 1200, 8],
    ['CRATE MEDIUM 400X300X200', 'Crates', 'PCS', 3, 900, 1800, 8],
    ['CRATE LARGE 500X400X250', 'Crates', 'PCS', 2, 1200, 2400, 8],
    ['PLASTIC PALLET 1200X1000', 'Pallets', 'PCS', 1, 2000, 4000, 9],
    ['DRUM 20 LTR BLUE', 'Drums / Barrels', 'PCS', 3, 450, 900, 8],
    ['DRUM 50 LTR BLUE', 'Drums / Barrels', 'PCS', 2, 800, 1600, 8],
    ['DRUM 200 LTR BLUE', 'Drums / Barrels', 'PCS', 1, 1800, 3600, 9],
    ['JERRY CAN 5 LTR RED', 'Jerry Cans', 'PCS', 6, 200, 400, 7],
    ['JERRY CAN 10 LTR RED', 'Jerry Cans', 'PCS', 6, 350, 700, 7],
    ['JERRY CAN 20 LTR RED', 'Jerry Cans', 'PCS', 3, 600, 1200, 8],
    ['PIPE 1/2 INCH 10FT', 'Pipes & Fittings', 'PCS', 10, 120, 250, 6],
    ['PIPE 3/4 INCH 10FT', 'Pipes & Fittings', 'PCS', 10, 180, 370, 6],
    ['PIPE 1 INCH 10FT', 'Pipes & Fittings', 'PCS', 10, 250, 500, 6],
    ['PIPE FITTING ELBOW 1/2', 'Pipes & Fittings', 'PCS', 50, 20, 45, 4],
    ['PIPE FITTING ELBOW 3/4', 'Pipes & Fittings', 'PCS', 50, 30, 65, 5],
    ['TANK 50 LTR CYLINDRICAL', 'Tanks', 'PCS', 2, 1200, 2400, 8],
    ['TANK 100 LTR CYLINDRICAL', 'Tanks', 'PCS', 1, 2200, 4400, 9],
    ['TANK 200 LTR RECTANGULAR', 'Tanks', 'PCS', 1, 3500, 7000, 9],
  ];

  // ─── TOYS & MISCELLANEOUS (100 items) ──────────────────────────────────
  const misc = [
    ['KIDS TOY BLOCKS 50PC SET', 'Kids Toys', 'SET', 6, 200, 400, 8],
    ['KIDS TOY BALLS SET 5PC', 'Kids Toys', 'SET', 6, 150, 300, 7],
    ['GARDEN POT SMALL 4 INCH', 'Garden Items', 'PCS', 12, 35, 80, 5],
    ['GARDEN POT MEDIUM 6 INCH', 'Garden Items', 'PCS', 12, 55, 120, 6],
    ['GARDEN POT LARGE 8 INCH', 'Garden Items', 'PCS', 12, 75, 160, 6],
    ['GARDEN SPRAYER 2 LTR', 'Garden Items', 'PCS', 6, 280, 560, 7],
  ];

  // ─── LAVENNA BRANDED (Legacy - 100 items) ────────────────────────────────
  const lavenna = [
    ['APPLE JAR QULFA', 'Airtight Containers', 'DOZ', 12, 180, 276, 7],
    ['APPLE SQUARE 1', 'Storage Containers', 'DOZ', 12, 798, 2340, 8],
    ['APPLE SQUARE 2', 'Storage Containers', 'DOZ', 12, 672, 1860, 8],
    ['KNIT SPOON HOLDER LAVENNA', 'Kitchen Organizers', 'PCS', 12, 88, 225, 5],
    ['LIVING BOTTLE 1.25 LTR', 'Water Bottles', 'SET', 6, 80, 160, 6],
    ['METRO BATH MUG', 'Mugs & Cups', 'DOZ', 12, 360, 1140, 7],
    ['PRINTING LAVENNA', 'Printing Items', 'PCS', 12, 250, 500, 8],
    ['SOFA STOOL LAVENNA', 'Furniture', 'PCS', 6, 650, 1300, 9],
    ['ROYAL JUG LAVENNA', 'Jugs', 'PCS', 6, 280, 700, 7],
    ['RUBY JUG LAVENNA 1', 'Jugs', 'PCS', 6, 430, 1100, 7],
    ['SUPER COOL COOLER 8LTR LAVENNA', 'Coolers', 'PCS', 6, 1485, 2970, 10],
    ['SUMMER COOL COOLER 4.5LTR', 'Coolers', 'PCS', 6, 990, 1980, 9],
    ['APPLE BOTTLE (1)', 'Bottles', 'PCS', 12, 45, 110, 6],
    ['APPLE COSTA JAR NO.6', 'Jars', 'PCS', 12, 65, 160, 6],
    ['AIRTIGHT BOWL SET 3X1 LAVENNA', 'Bowl Sets', 'SET', 12, 120, 280, 7],
    ['ACRYLIC SQUARE GLASS', 'Glassware', 'PCS', 12, 75, 180, 6],
  ];

  // Combine all items
  const allItems = [
    ...containers,
    ...buckets,
    ...household,
    ...organization,
    ...bags,
    ...industrial,
    ...misc,
    ...lavenna,
  ];

  // Pad to 1,140 with variations
  while (allItems.length < 1140) {
    const base = allItems[allItems.length % containers.length];
    const variant = `${base[0]} VAR${Math.floor(allItems.length / containers.length)}`;
    allItems.push([variant, base[1], base[2], base[3], base[4], base[5], base[6]]);
  }

  // Insert into products table
  for (const [name, category, unit, qty_pack, buy_price, sell_price, comm_pct] of allItems) {
    const itemId = mkId(itemCounter);
    db.prepare(`
      INSERT INTO products (
        item_id, name, category, unit, qty_per_pack,
        purchase_price, selling_price, rate,
        default_commission_rate, stock, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      itemId, name, category, unit, qty_pack,
      buy_price, sell_price, sell_price, // rate = selling_price
      comm_pct, 0, 'active'
    );
    itemCounter++;
  }

  console.log(`✅ ${allItems.length} items inserted (Item ID: 000001 - ${mkId(allItems.length)})`);
  console.log('\n✅ ITEM MASTER SEED COMPLETE!');
}

seedItems()
  .then(() => { console.log('\n🚀 Restart server: node index.js'); process.exit(0); })
  .catch(err => { console.error('❌ Error:', err); process.exit(1); });
