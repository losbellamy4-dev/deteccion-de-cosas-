# models/ — pesos de los modelos

Esta carpeta debe contener (rutas exactas, ver `README.md` §3.2 para orígenes y SHA-256):

```
models/pose/pose_landmarker_lite.task      obligatorio
models/pose/pose_landmarker_full.task      opcional (variante "Full")
models/pose/pose_landmarker_heavy.task     opcional (variante "Heavy")
models/hands/hand_landmarker.task          obligatorio
models/face/face_landmarker.task           obligatorio
models/coco-ssd/model.json                 obligatorio
models/coco-ssd/group1-shard1of5 … group1-shard5of5   obligatorios
```

Descárgalos de una vez con:

```bash
python tools/descargar_dependencias.py            # añade --pose-full / --pose-heavy si quieres las variantes
```
