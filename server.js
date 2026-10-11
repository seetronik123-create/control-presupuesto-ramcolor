const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Conexión a SQLite
const db = new sqlite3.Database('./presupuestos.db', (err) => {
    if (err) {
        console.error('Error al abrir la base de datos', err.message);
    } else {
        console.log('Conectado a la base de datos SQLite.');
    }
});

// Crear tablas con soporte para guardar el PDF en formato base64/texto
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS proyectos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre_cliente TEXT,
        cotizacion_n TEXT,
        valor_total REAL,
        pdf_data TEXT,
        pdf_nombre TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS movimientos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        proyecto_id INTEGER,
        tipo TEXT, 
        descripcion TEXT,
        monto REAL,
        fecha TEXT,
        FOREIGN KEY(proyecto_id) REFERENCES proyectos(id) ON DELETE CASCADE
    )`);
});

// API: Obtener todos los proyectos
app.get('/api/proyectos', (req, res) => {
    db.all('SELECT id, nombre_cliente, cotizacion_n, valor_total, pdf_nombre FROM proyectos ORDER BY id DESC', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// API: Crear nueva cotización con PDF opcional
app.post('/api/proyectos', (req, res) => {
    const { nombre_cliente, cotizacion_n, valor_total, pdf_data, pdf_nombre } = req.body;
    
    const cliente = nombre_cliente || "Cliente General";
    const cotizacionN = cotizacion_n || "1";
    const valorTotal = parseFloat(valor_total) || 0;

    db.run('INSERT INTO proyectos (nombre_cliente, cotizacion_n, valor_total, pdf_data, pdf_nombre) VALUES (?, ?, ?, ?, ?)',
        [cliente, cotizacionN, valorTotal, pdf_data || null, pdf_nombre || null], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ 
                id: this.lastID, 
                mensaje: 'Cotización creada con éxito'
            });
        });
});

// API: Eliminar cotización completa
app.delete('/api/proyectos/:id', (req, res) => {
    const proyectoId = req.params.id;
    db.serialize(() => {
        db.run('DELETE FROM movimientos WHERE proyecto_id = ?', [proyectoId]);
        db.run('DELETE FROM proyectos WHERE id = ?', [proyectoId], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ mensaje: 'Cotización eliminada correctamente' });
        });
    });
});

// API: Obtener resumen financiero y PDF de una cotización
app.get('/api/proyecto/:id', (req, res) => {
    const proyectoId = req.params.id;

    db.get('SELECT id, nombre_cliente, cotizacion_n, valor_total, pdf_nombre, CASE WHEN pdf_data IS NOT NULL THEN 1 ELSE 0 END as tiene_pdf FROM proyectos WHERE id = ?', [proyectoId], (err, proyecto) => {
        if (err || !proyecto) return res.status(404).json({ error: 'Proyecto no encontrado' });

        db.all('SELECT * FROM movimientos WHERE proyecto_id = ?', [proyectoId], (err, movimientos) => {
            if (err) return res.status(500).json({ error: err.message });

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
        });
    });
});

// API: Descargar el PDF guardado de la cotización
app.get('/api/proyecto/:id/pdf', (req, res) => {
    const proyectoId = req.params.id;
    db.get('SELECT pdf_data, pdf_nombre FROM proyectos WHERE id = ?', [proyectoId], (err, row) => {
        if (err || !row || !row.pdf_data) {
            return res.status(404).send('PDF no encontrado para este proyecto.');
        }
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
    });
});

// API: Registrar movimiento
app.post('/api/movimientos', (req, res) => {
    const { proyecto_id, tipo, descripcion, monto } = req.body;
    const fecha = new Date().toISOString().split('T')[0];

    db.run('INSERT INTO movimientos (proyecto_id, tipo, descripcion, monto, fecha) VALUES (?, ?, ?, ?, ?)',
        [proyecto_id, tipo, descripcion, monto, fecha], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ id: this.lastID, mensaje: 'Movimiento registrado con éxito' });
        });
});

// API: Eliminar movimiento
app.delete('/api/movimientos/:id', (req, res) => {
    const movId = req.params.id;
    db.run('DELETE FROM movimientos WHERE id = ?', [movId], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ mensaje: 'Movimiento eliminado correctamente' });
    });
});

app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});