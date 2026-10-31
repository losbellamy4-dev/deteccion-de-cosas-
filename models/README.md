# models/ — pesos de los modelos

Esta carpeta debe contener (rutas exactas, ver `README.md` §3.2 para orígenes y SHA-256):

```
models/pose/pose_landmarker_lite.task      obligatorio
models/pose/pose_landmarker_full.task      opcional (variante "Full")
models/pose/pose_landmarker_heavy.task     opcional (variante "Heavy")
models/hands/hand_landmarker.task          obligatorio
models/face/face_landmarker.task           obligatorio
models/objects/efficientdet_lite0.tflite   obligatorio (objetos, modelo por defecto)
models/objects/efficientdet_lite2.tflite   opcional (objetos, modo «más preciso»)
models/classifier/efficientnet_lite0.tflite  obligatorio (reconocer 1000 cosas)
models/coco-ssd/model.json                 opcional (modelo alternativo COCO-SSD)
models/coco-ssd/group1-shard1of5 … group1-shard5of5   opcionales (COCO-SSD)
```

El repositorio ya los incluye (salvo la variante «heavy» de pose). Si faltan, descárgalos con:

```bash
python tools/descargar_dependencias.py            # añade --pose-full / --pose-heavy si quieres las variantes
```
