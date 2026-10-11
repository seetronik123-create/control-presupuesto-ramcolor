const express = require('express');
const { createClient } = require('@libsql/client');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Conexión a Turso (Base de datos en la nube)
const db = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
});

// Inicializar tablas en Turso de forma automática
async function initDatabase() {
    try {
        await db.execute(`CREATE TABLE IF NOT EXISTS proyectos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre_cliente TEXT,
            cotizacion_n TEXT,
            valor_total REAL,
            pdf_data TEXT,
            pdf_nombre TEXT
        )`);

        await db.execute(`CREATE TABLE IF NOT EXISTS movimientos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            proyecto_id INTEGER,
            tipo TEXT, 
            descripcion TEXT,
            monto REAL,
            fecha TEXT,
            FOREIGN KEY(proyecto_id) REFERENCES proyectos(id) ON DELETE CASCADE
        )`);
        console.log("Tablas de Turso inicializadas correctamente.");
    } catch (err) {
        console.error("Error al inicializar la base de datos en Turso:", err.message);
    }
}

initDatabase();

// API: Obtener todos los proyectos
app.get('/api/proyectos', async (req, res) => {
    try {
        const result = await db.execute('SELECT id, nombre_cliente, cotizacion_n, valor_total, pdf_nombre FROM proyectos ORDER BY id DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Crear nueva cotización con PDF opcional
app.post('/api/proyectos', async (req, res) => {
    try {
        const { nombre_cliente, cotizacion_n, valor_total, pdf_data, pdf_nombre } = req.body;
        
        const cliente = nombre_cliente || "Cliente General";
        const cotizacionN = cotizacion_n || "1";
        const valorTotal = parseFloat(valor_total) || 0;

        const result = await db.execute({
            sql: 'INSERT INTO proyectos (nombre_cliente, cotizacion_n, valor_total, pdf_data, pdf_nombre) VALUES (?, ?, ?, ?, ?)',
            args: [cliente, cotizacionN, valorTotal, pdf_data || null, pdf_nombre || null]
        });

        res.json({ 
            id: Number(result.lastInsertRowid), 
            mensaje: 'Cotización creada con éxito'
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Eliminar cotización completa (con transacción)
app.delete('/api/proyectos/:id', async (req, res) => {
    try {
        const proyectoId = req.params.id;
        const tx = await db.transaction('write');
        try {
            await tx.execute({ sql: 'DELETE FROM movimientos WHERE proyecto_id = ?', args: [proyectoId] });
            await tx.execute({ sql: 'DELETE FROM proyectos WHERE id = ?', args: [proyectoId] });
            await tx.commit();
            res.json({ mensaje: 'Cotización eliminada correctamente' });
        } catch (txErr) {
            await tx.rollback();
            throw txErr;
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Obtener resumen financiero y PDF de una cotización
app.get('/api/proyecto/:id', async (req, res) => {
    try {
        const proyectoId = req.params.id;

        const proyectoRes = await db.execute({
            sql: 'SELECT id, nombre_cliente, cotizacion_n, valor_total, pdf_nombre, CASE WHEN pdf_data IS NOT NULL THEN 1 ELSE 0 END as tiene_pdf FROM proyectos WHERE id = ?',
            args: [proyectoId]
        });

        if (proyectoRes.rows.length === 0) {
            return res.status(404).json({ error: 'Proyecto no encontrado' });
        }
        const proyecto = proyectoRes.rows[0];

        const movRes = await db.execute({
            sql: 'SELECT * FROM movimientos WHERE proyecto_id = ?',
            args: [proyectoId]
        });
        const movimientos = movRes.rows;

        let totalAdelantos = 0, totalMateriales = 0, totalTrabajadores = 0, totalOperativos = 0;
        movimientos.forEach(m => {
            if (m.tipo === 'adelanto') totalAdelantos += m.monto;
            if (m.tipo === 'material') totalMateriales += m.monto;
            if (m.tipo === 'trabajador') totalTrabajadores += m.monto;
            if (m.tipo === 'operativo') totalOperativos += m.monto;
        });

        const totalGastos = totalMateriales + totalTrabajadores + totalOperativos;
        const gananciaNeta = proyecto.valor_total - totalGastos;
        const saldoPendienteCobrar = proyecto.valor_total - totalAdelantos;
        const margenRentabilidad = proyecto.valor_total > 0 ? (gananciaNeta / proyecto.valor_total) * 100 : 0;

        res.json({
            proyecto,
            movimientos,
            resumen: {
                valorTotal: proyecto.valor_total,
                totalAdelantos,
                saldoPendienteCobrar,
                totalMateriales,
                totalTrabajadores,
                totalOperativos,
                totalGastos,
                gananciaNeta,
                margenRentabilidad: margenRentabilidad.toFixed(2)
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Descargar el PDF guardado de la cotización
app.get('/api/proyecto/:id/pdf', async (req, res) => {
    try {
        const proyectoId = req.params.id;
        const result = await db.execute({
            sql: 'SELECT pdf_data, pdf_nombre FROM proyectos WHERE id = ?',
            args: [proyectoId]
        });

        if (result.rows.length === 0 || !result.rows[0].pdf_data) {
            return res.status(404).send('PDF no encontrado para este proyecto.');
        }
        const row = result.rows[0];

        const matches = row.pdf_data.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
        let buffer;
        if (matches && matches.length === 3) {
            buffer = Buffer.from(matches[2], 'base64');
        } else {
            buffer = Buffer.from(row.pdf_data, 'base64');
        }

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${row.pdf_nombre || 'cotizacion.pdf'}"`);
        res.send(buffer);
    } catch (err) {
        res.status(500).send('Error al procesar el PDF');
    }
});

// API: Registrar movimiento
app.post('/api/movimientos', async (req, res) => {
    try {
        const { proyecto_id, tipo, descripcion, monto } = req.body;
        const fecha = new Date().toISOString().split('T')[0];

        const result = await db.execute({
            sql: 'INSERT INTO movimientos (proyecto_id, tipo, descripcion, monto, fecha) VALUES (?, ?, ?, ?, ?)',
            args: [proyecto_id, tipo, descripcion, monto, fecha]
        });

        res.json({ id: Number(result.lastInsertRowid), mensaje: 'Movimiento registrado con éxito' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Eliminar movimiento
app.delete('/api/movimientos/:id', async (req, res) => {
    try {
        const movId = req.params.id;
        await db.execute({
            sql: 'DELETE FROM movimientos WHERE id = ?',
            args: [movId]
        });
        res.json({ mensaje: 'Movimiento eliminado correctamente' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
});