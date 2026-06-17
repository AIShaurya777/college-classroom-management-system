const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');
const { verifyToken, verifyAdmin } = require('./authMiddleware');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// ============================================
// AUTH ROUTES
// ============================================

// POST /auth/login
app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await db.query(
      `SELECT u.id, u.name, u.email, u.password_hash, u.role_id, r.role_name
       FROM users u
       JOIN roles r ON u.role_id = r.id
       WHERE u.email = $1`,
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign(
      { id: user.id, role_id: user.role_id, role: user.role_name },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role_name,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================
// ROOM TYPES
// ============================================

// GET /room_types
app.get('/room_types', async (req, res) => {
  try {
    const result = await db.query('SELECT id, type_name FROM room_types ORDER BY id');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================
// USERS
// ============================================

// GET /users
app.get('/users', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT u.id, u.name, r.role_name
       FROM users u
       JOIN roles r ON u.role_id = r.id
       ORDER BY u.id`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================
// AVAILABILITY (THE COMPLEX QUERY)
// ============================================

// GET /rooms/availability?type_id=&min_capacity=&date=
app.get('/rooms/availability', async (req, res) => {
  try {
    const { type_id, min_capacity, date } = req.query;

    const result = await db.query(
      `WITH RoomSlots AS (
         SELECT r.id AS room_id, r.name AS room_name, r.capacity,
                ts.id AS slot_id,
                TO_CHAR(ts.start_time, 'HH24:MI') AS start_time,
                TO_CHAR(ts.end_time, 'HH24:MI') AS end_time
         FROM rooms r
         CROSS JOIN time_slots ts
         WHERE r.room_type_id = $1
           AND r.capacity >= $2
           AND r.is_active = TRUE
       ),
       BookedSlots AS (
         SELECT b.room_id, bs.slot_id
         FROM bookings b
         JOIN booking_slots bs ON b.id = bs.booking_id
         WHERE b.booking_date = $3
           AND b.status = 'CONFIRMED'
       )
       SELECT rs.room_id, rs.room_name, rs.capacity,
              rs.slot_id, rs.start_time, rs.end_time,
              CASE WHEN bk.room_id IS NOT NULL THEN 'BOOKED' ELSE 'AVAILABLE' END AS status
       FROM RoomSlots rs
       LEFT JOIN BookedSlots bk ON rs.room_id = bk.room_id AND rs.slot_id = bk.slot_id
       ORDER BY rs.room_name, rs.start_time`,
      [type_id, min_capacity, date]
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================
// BOOKINGS
// ============================================

// POST /bookings — Create booking (via stored procedure)
app.post('/bookings', verifyToken, async (req, res) => {
  try {
    const { room_id, date, slot_ids } = req.body;
    const user_id = req.user.id;

    await db.query('CALL sp_create_booking($1, $2, $3, $4)', [
      user_id,
      room_id,
      date,
      slot_ids,
    ]);

    res.json({ message: 'Booking successful' });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message || 'Booking failed' });
  }
});

// GET /my-bookings — User's bookings
app.get('/my-bookings', verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await db.query(
      `SELECT b.id AS booking_id, r.name AS room_name,
              b.booking_date, b.status,
              json_agg(
                json_build_object(
                  'start_time', TO_CHAR(ts.start_time, 'HH24:MI'),
                  'end_time', TO_CHAR(ts.end_time, 'HH24:MI')
                ) ORDER BY ts.start_time
              ) AS slots
       FROM bookings b
       JOIN rooms r ON b.room_id = r.id
       JOIN booking_slots bs ON b.id = bs.booking_id
       JOIN time_slots ts ON bs.slot_id = ts.id
       WHERE b.user_id = $1
       GROUP BY b.id, r.name, b.booking_date, b.status
       ORDER BY b.booking_date DESC`,
      [userId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /bookings/:id/cancel — Cancel a booking
app.patch('/bookings/:id/cancel', verifyToken, async (req, res) => {
  try {
    const bookingId = parseInt(req.params.id);
    const userId = req.user.id;

    await db.query('CALL sp_cancel_booking($1, $2)', [bookingId, userId]);

    res.json({ message: 'Booking cancelled' });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message || 'Cannot cancel booking' });
  }
});

// GET /bookings/date/:date — All bookings for a date (admin)
app.get('/bookings/date/:date', verifyAdmin, async (req, res) => {
  try {
    const { date } = req.params;

    const result = await db.query(
      `SELECT b.id, u.name AS user_name, r.name AS room_name, b.status,
              json_agg(
                json_build_object(
                  'start_time', TO_CHAR(ts.start_time, 'HH24:MI'),
                  'end_time', TO_CHAR(ts.end_time, 'HH24:MI')
                ) ORDER BY ts.start_time
              ) AS slots
       FROM bookings b
       JOIN users u ON b.user_id = u.id
       JOIN rooms r ON b.room_id = r.id
       JOIN booking_slots bs ON b.id = bs.booking_id
       JOIN time_slots ts ON bs.slot_id = ts.id
       WHERE b.booking_date = $1
       GROUP BY b.id, u.name, r.name, b.status
       ORDER BY b.id`,
      [date]
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /bookings?date=&room_id=&status= — Dynamic filter bookings (admin)
app.get('/bookings', verifyAdmin, async (req, res) => {
  try {
    const { date, room_id, status } = req.query;
    let query = `
      SELECT b.id, u.name AS user_name, r.name AS room_name,
             b.booking_date, b.status,
             json_agg(
               json_build_object(
                 'start_time', TO_CHAR(ts.start_time, 'HH24:MI'),
                 'end_time', TO_CHAR(ts.end_time, 'HH24:MI')
               ) ORDER BY ts.start_time
             ) AS slots
      FROM bookings b
      JOIN users u ON b.user_id = u.id
      JOIN rooms r ON b.room_id = r.id
      JOIN booking_slots bs ON b.id = bs.booking_id
      JOIN time_slots ts ON bs.slot_id = ts.id
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    if (date) {
      query += ` AND b.booking_date = $${paramIndex++}`;
      params.push(date);
    }
    if (room_id) {
      query += ` AND b.room_id = $${paramIndex++}`;
      params.push(room_id);
    }
    if (status) {
      query += ` AND b.status = $${paramIndex++}`;
      params.push(status);
    }

    query += ` GROUP BY b.id, u.name, r.name, b.booking_date, b.status ORDER BY b.id`;

    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================
// ADMIN STATS
// ============================================

// GET /admin/stats/rooms — Most popular rooms
app.get('/admin/stats/rooms', verifyAdmin, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT r.name, COUNT(b.id) AS total_bookings
       FROM bookings b
       JOIN rooms r ON b.room_id = r.id
       WHERE b.status = 'CONFIRMED'
       GROUP BY r.name
       ORDER BY total_bookings DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /admin/stats/slots — Most used time slots
app.get('/admin/stats/slots', verifyAdmin, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT TO_CHAR(ts.start_time, 'HH24:MI') AS start_time,
              TO_CHAR(ts.end_time, 'HH24:MI') AS end_time,
              COUNT(bs.slot_id) AS usage_count
       FROM booking_slots bs
       JOIN time_slots ts ON bs.slot_id = ts.id
       JOIN bookings b ON bs.booking_id = b.id
       WHERE b.status = 'CONFIRMED'
       GROUP BY ts.start_time, ts.end_time
       ORDER BY usage_count DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /admin/stats/days — Bookings per day
app.get('/admin/stats/days', verifyAdmin, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT booking_date, COUNT(*) AS total
       FROM bookings
       WHERE status = 'CONFIRMED'
       GROUP BY booking_date
       ORDER BY total DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================
// ROOM MANAGEMENT
// ============================================

// GET /rooms — All active rooms
app.get('/rooms', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT r.id, r.name, rt.type_name, r.capacity
       FROM rooms r
       JOIN room_types rt ON r.room_type_id = rt.id
       WHERE r.is_active = TRUE
       ORDER BY r.name`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /rooms/:id/schedule?date= — Single room schedule for a date
app.get('/rooms/:id/schedule', async (req, res) => {
  try {
    const roomId = parseInt(req.params.id);
    const { date } = req.query;

    const result = await db.query(
      `SELECT ts.id AS slot_id,
              TO_CHAR(ts.start_time, 'HH24:MI') AS start_time,
              TO_CHAR(ts.end_time, 'HH24:MI') AS end_time,
              CASE WHEN bs.slot_id IS NOT NULL THEN 'BOOKED' ELSE 'AVAILABLE' END AS status
       FROM time_slots ts
       LEFT JOIN (
         SELECT bs.slot_id
         FROM bookings b
         JOIN booking_slots bs ON b.id = bs.booking_id
         WHERE b.room_id = $1 AND b.booking_date = $2 AND b.status = 'CONFIRMED'
       ) bs ON ts.id = bs.slot_id
       ORDER BY ts.start_time`,
      [roomId, date]
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /rooms — Create room (admin)
app.post('/rooms', verifyAdmin, async (req, res) => {
  try {
    const { name, room_type_id, capacity } = req.body;

    const result = await db.query(
      `INSERT INTO rooms (name, room_type_id, capacity)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [name, room_type_id, capacity]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Room name already exists' });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /rooms/:id — Soft delete room (admin)
app.delete('/rooms/:id', verifyAdmin, async (req, res) => {
  try {
    const roomId = parseInt(req.params.id);

    await db.query('UPDATE rooms SET is_active = FALSE WHERE id = $1', [roomId]);

    res.json({ message: 'Room deactivated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================
// START SERVER
// ============================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
