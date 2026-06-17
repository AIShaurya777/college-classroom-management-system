const bcrypt = require('bcryptjs');
const db = require('./db');

async function seed() {
  const client = await db.pool.connect();

  try {
    console.log('Starting seed...');

    // --- Roles ---
    await client.query(`
      INSERT INTO roles (role_name) VALUES ('ADMIN'), ('FACULTY')
      ON CONFLICT DO NOTHING
    `);
    console.log('Roles seeded.');

    // --- Room Types ---
    await client.query(`
      INSERT INTO room_types (type_name) VALUES
        ('Lecture Hall'), ('Lab'), ('Classroom'), ('Meeting Room')
      ON CONFLICT DO NOTHING
    `);
    console.log('Room types seeded.');

    // --- Time Slots (12 × 50-minute slots, 08:00–18:00) ---
    const slotStarts = [
      '08:00', '08:50', '09:40', '10:30', '11:20', '12:10',
      '13:00', '13:50', '14:40', '15:30', '16:20', '17:10',
    ];
    const slotEnds = [
      '08:50', '09:40', '10:30', '11:20', '12:10', '13:00',
      '13:50', '14:40', '15:30', '16:20', '17:10', '18:00',
    ];
    for (let i = 0; i < slotStarts.length; i++) {
      await client.query(
        `INSERT INTO time_slots (start_time, end_time) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [slotStarts[i], slotEnds[i]]
      );
    }
    console.log('Time slots seeded.');

    // --- Users (100 users) ---
    const passwordHash = await bcrypt.hash('password', 10);
    const adminRoleResult = await client.query(`SELECT id FROM roles WHERE role_name = 'ADMIN'`);
    const facultyRoleResult = await client.query(`SELECT id FROM roles WHERE role_name = 'FACULTY'`);
    const adminRoleId = adminRoleResult.rows[0].id;
    const facultyRoleId = facultyRoleResult.rows[0].id;

    for (let i = 1; i <= 100; i++) {
      const name = `User ${i}`;
      const email = `user${i}@thapar.edu`;
      const roleId = i === 1 ? adminRoleId : facultyRoleId;
      await client.query(
        `INSERT INTO users (name, email, password_hash, role_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (email) DO NOTHING`,
        [name, email, passwordHash, roleId]
      );
    }
    console.log('Users seeded (100 users).');

    // --- Get room type IDs ---
    const rtResult = await client.query(`SELECT id, type_name FROM room_types`);
    const roomTypeMap = {};
    rtResult.rows.forEach(r => { roomTypeMap[r.type_name] = r.id; });

    // --- Rooms ---
    // Labs: LP-101 to LP-110
    for (let i = 1; i <= 10; i++) {
      const name = `LP-${100 + i}`;
      const capacity = i <= 5 ? 150 : 250;
      await client.query(
        `INSERT INTO rooms (name, room_type_id, capacity) VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING`,
        [name, roomTypeMap['Lab'], capacity]
      );
    }

    // Lecture Halls: LT-101 to LT-403 (4 floors, 3 per floor)
    for (let floor = 1; floor <= 4; floor++) {
      for (let room = 1; room <= 3; room++) {
        const name = `LT-${floor}0${room}`;
        const capacity = floor === 1 ? 500 : 180;
        await client.query(
          `INSERT INTO rooms (name, room_type_id, capacity) VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING`,
          [name, roomTypeMap['Lecture Hall'], capacity]
        );
      }
    }

    // Classrooms: A-1 to A-20, B-1 to B-20, C-1 to C-20, D-1 to D-18
    const blocks = [
      { prefix: 'A', count: 20 },
      { prefix: 'B', count: 20 },
      { prefix: 'C', count: 20 },
      { prefix: 'D', count: 18 },
    ];
    for (const block of blocks) {
      for (let i = 1; i <= block.count; i++) {
        const name = `${block.prefix}-${i}`;
        const capacity = Math.floor(Math.random() * 71) + 30; // 30–100
        await client.query(
          `INSERT INTO rooms (name, room_type_id, capacity) VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING`,
          [name, roomTypeMap['Classroom'], capacity]
        );
      }
    }
    console.log('Rooms seeded (~100 rooms).');

    // --- Bookings (200 random attempts) ---
    const usersResult = await client.query(`SELECT id FROM users`);
    const roomsResult = await client.query(`SELECT id FROM rooms WHERE is_active = TRUE`);
    const slotsResult = await client.query(`SELECT id FROM time_slots ORDER BY id`);
    const userIds = usersResult.rows.map(r => r.id);
    const roomIds = roomsResult.rows.map(r => r.id);
    const slotIds = slotsResult.rows.map(r => r.id);

    let successCount = 0;
    for (let i = 0; i < 200; i++) {
      const userId = userIds[Math.floor(Math.random() * userIds.length)];
      const roomId = roomIds[Math.floor(Math.random() * roomIds.length)];

      // Random date within next 7 days
      const today = new Date();
      const dayOffset = Math.floor(Math.random() * 7);
      const bookingDate = new Date(today);
      bookingDate.setDate(today.getDate() + dayOffset);
      const dateStr = bookingDate.toISOString().split('T')[0];

      // 1–3 contiguous slots
      const numSlots = Math.floor(Math.random() * 3) + 1;
      const startSlotIndex = Math.floor(Math.random() * (slotIds.length - numSlots + 1));
      const selectedSlots = slotIds.slice(startSlotIndex, startSlotIndex + numSlots);

      try {
        await client.query('CALL sp_create_booking($1, $2, $3, $4)', [
          userId,
          roomId,
          dateStr,
          selectedSlots,
        ]);
        successCount++;
      } catch (err) {
        // Silently ignore overlaps (double-booking trigger will reject)
      }
    }
    console.log(`Bookings seeded: ${successCount}/200 succeeded.`);

    console.log('\nSeed completed successfully!');
    console.log('Admin login: user1@thapar.edu / password');
    console.log('Faculty login: user2@thapar.edu / password');
  } catch (err) {
    console.error('Seed error:', err);
  } finally {
    client.release();
    await db.pool.end();
  }
}

seed();
